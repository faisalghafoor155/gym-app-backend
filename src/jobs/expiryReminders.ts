import { Prisma, type GymPlan } from '@prisma/client';
import prisma from '../db.js';
import { mailEnabled, membershipExpiryMail, sendMail } from '../services/mail.js';
import { templates } from '../services/whatsapp.js';
import { messagingEnabled, sendMemberMessage } from '../services/messaging.js';
import { canWhatsApp } from '../services/phone.js';
import { planHasFeature } from '../services/subscription.js';

/**
 * Tells members their membership is ending, on the day it does and a few days
 * before.
 *
 * Runs once a day, but is written so that running it more than once is
 * harmless. That distinction matters more than it sounds: a restart, a
 * redeploy, or a second backend instance all re-run it, and a member who
 * receives the same notice three times learns to ignore the first one next
 * month. `ReminderLog` is what makes each send idempotent rather than merely
 * scheduled — the row is claimed before the send, and a duplicate insert is
 * how a second attempt discovers there is nothing to do.
 *
 * Both transports, independently. A member with an address and a number gets
 * told both ways, because in Pakistan the email is rarely opened and the
 * WhatsApp almost always is, and neither is reliable enough alone. The channel
 * is part of the claim, so one transport being down never marks the other as
 * already handled.
 *
 * Still deliberately narrow. Two notices per membership and no more: no
 * chasing of members who lapsed months ago, no third reminder a week later.
 * Each of those is a decision about how often a gym should contact its
 * members, which belongs to the gym rather than to this file.
 */

/** How many days before expiry the early warning goes out. */
const WARN_DAYS = Number(process.env.REMINDER_WARN_DAYS ?? 3);

/** Midnight to midnight for the day a run belongs to. */
const dayBounds = (now: Date): { start: Date; end: Date } => {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

/** The same window, `days` ahead of the one a run belongs to. */
const daysAhead = (now: Date, days: number): { start: Date; end: Date } => {
  const shifted = new Date(now);
  shifted.setDate(shifted.getDate() + days);
  return dayBounds(shifted);
};

/** Midnight, as a date-only value the `sentOn` column can hold. */
const dayOf = (now: Date): Date => dayBounds(now).start;

export interface ReminderRun {
  /** Memberships expiring today, whether or not anyone could be told. */
  due: number;
  /** Memberships expiring in `WARN_DAYS` days. */
  dueSoon: number;
  sent: number;
  sentWhatsApp: number;
  /** Already handled by an earlier run, or by another instance. */
  skippedAlreadySent: number;
  /** Expiring, but the member has no address on file. */
  skippedNoEmail: number;
  /** No number that WhatsApp can reach, or the member asked not to be
   *  messaged there. */
  skippedNoWhatsApp: number;
  /** The transport was configured and refused. */
  failed: number;
}

const emptyRun = (): ReminderRun => ({
  due: 0,
  dueSoon: 0,
  sent: 0,
  sentWhatsApp: 0,
  skippedAlreadySent: 0,
  skippedNoEmail: 0,
  skippedNoWhatsApp: 0,
  failed: 0,
});

/** What the job needs about one membership to decide and to write the notice. */
type Expiring = {
  id: string;
  gymId: string;
  member: { name: string; email: string | null; phone: string | null; status: string; whatsappOptOut: boolean };
  plan: { name: string };
  gym: { name: string; plan: GymPlan };
};

const findExpiring = (start: Date, end: Date) =>
  prisma.membership.findMany({
    where: {
      // Only a live membership. A cancelled or suspended one ending today is
      // not news, and a superseded one has already been replaced by the
      // renewal this notice would be asking for.
      status: 'active',
      expiryDate: { gte: start, lte: end },
    },
    select: {
      id: true,
      gymId: true,
      member: {
        select: { name: true, email: true, phone: true, status: true, whatsappOptOut: true },
      },
      plan: { select: { name: true } },
      // `plan` decides whether this gym's tier includes WhatsApp. Selected
      // here rather than looked up per member: the gym is already joined, so
      // it costs nothing, and a query inside the loop would run once for every
      // membership expiring anywhere.
      gym: { select: { name: true, plan: true } },
    },
  });

/**
 * Claims one (membership, kind, channel, day) before it is sent.
 *
 * Claiming first means two instances racing on the same notice have exactly
 * one winner, and the loser finds out here rather than after the member has
 * two copies. Returns false when somebody else already holds it.
 */
const claim = async (
  m: Expiring,
  kind: 'membershipExpiry' | 'membershipExpiringSoon',
  channel: 'email' | 'whatsapp',
  sentTo: string,
  sentOn: Date,
): Promise<boolean> => {
  try {
    await prisma.reminderLog.create({
      data: { gymId: m.gymId, membershipId: m.id, kind, channel, sentOn, sentTo },
    });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return false;
    }
    throw err;
  }
};

/** Gives a claim back so tomorrow's run tries again. */
const release = (
  m: Expiring,
  kind: 'membershipExpiry' | 'membershipExpiringSoon',
  channel: 'email' | 'whatsapp',
  sentOn: Date,
) => prisma.reminderLog.deleteMany({
  where: { membershipId: m.id, kind, channel, sentOn },
});

/**
 * Sends one kind of notice to everybody it is due for, by both transports.
 *
 * Counts are accumulated into `run` rather than returned so the two passes —
 * today's expiries and the early warnings — report as one job.
 */
const notify = async (
  memberships: Expiring[],
  kind: 'membershipExpiry' | 'membershipExpiringSoon',
  sentOn: Date,
  run: ReminderRun,
  days: number,
): Promise<void> => {
  for (const m of memberships) {
    const { member } = m;

    // A member somebody deactivated by hand is not somebody to chase.
    if (member.status !== 'active') continue;

    // --- Email -------------------------------------------------------------
    if (!member.email) {
      run.skippedNoEmail++;
    } else if (!(await claim(m, kind, 'email', member.email, sentOn))) {
      run.skippedAlreadySent++;
    } else {
      const ok = await sendMail({
        to: member.email,
        fromName: m.gym.name,
        ...membershipExpiryMail(member.name, m.gym.name, m.plan.name),
      });

      if (ok) {
        run.sent++;
      } else {
        run.failed++;
        // The claim is given back so tomorrow's run tries again. Keeping it
        // would mean one unreachable mail server silently costs a member their
        // only notice — a duplicate is the cheaper of the two failures.
        //
        // Only when mail is actually configured: with no transport, `sendMail`
        // logs and reports false every time, and releasing the claim would
        // reprint the same notice on every run for ever.
        if (mailEnabled) await release(m, kind, 'email', sentOn);
      }
    }

    // --- WhatsApp ----------------------------------------------------------
    // Independent of the email above, including of whether it succeeded: a
    // member with both should hear both ways, and the whole point of adding
    // this transport is that the email may well go unread.
    //
    // A gym that has not set WhatsApp up is not failing to send — it is not
    // sending, which is a different thing and must not colour the run's
    // failure count. Checked before the number so an unconfigured install
    // reports nothing about WhatsApp at all rather than a skip per member.
    if (!messagingEnabled()) continue;

    // Nor is a gym whose plan does not include it. Same reasoning, one tier
    // up: the email above still went, so a free gym's members are still told
    // their membership is ending — they are told once instead of twice.
    if (!planHasFeature(m.gym.plan, 'whatsapp')) continue;

    if (member.whatsappOptOut || !canWhatsApp(member.phone)) {
      run.skippedNoWhatsApp++;
      continue;
    }

    if (!(await claim(m, kind, 'whatsapp', member.phone!, sentOn))) {
      run.skippedAlreadySent++;
      continue;
    }

    const result = await sendMemberMessage({
      to: member.phone!,
      ...(kind === 'membershipExpiry'
        ? templates.membershipExpiry(member.name, m.gym.name, m.plan.name)
        : templates.membershipExpiringSoon(
            member.name, m.gym.name, m.plan.name, String(days),
          )),
    });

    if (result === 'sent') {
      run.sentWhatsApp++;
      continue;
    }

    // `skipped` cannot reach here — the number was already checked — and
    // WhatsApp is configured, so this is a real refusal by Meta.
    run.failed++;
    // Released on the same reasoning as the mail above: one refusal must not
    // silently cost a member their notice, and a duplicate is the cheaper of
    // the two failures.
    await release(m, kind, 'whatsapp', sentOn);
  }
};

/**
 * Sends today's reminders: the memberships ending today, and those ending in
 * `WARN_DAYS` days.
 *
 * `now` is injected so the job is testable without waiting for a date to come
 * round, on the same terms as the membership helpers it sits beside.
 */
export const runExpiryReminders = async (now: Date = new Date()): Promise<ReminderRun> => {
  const sentOn = dayOf(now);
  const run = emptyRun();

  const today = dayBounds(now);
  const expiringToday = await findExpiring(today.start, today.end);
  run.due = expiringToday.length;
  await notify(expiringToday, 'membershipExpiry', sentOn, run, 0);

  // The early warning. Skipped entirely when configured to zero days, which is
  // how a gym turns it off without turning off the notice on the day itself.
  if (WARN_DAYS > 0) {
    const ahead = daysAhead(now, WARN_DAYS);
    const expiringSoon = await findExpiring(ahead.start, ahead.end);
    run.dueSoon = expiringSoon.length;
    await notify(expiringSoon, 'membershipExpiringSoon', sentOn, run, WARN_DAYS);
  }

  return run;
};
