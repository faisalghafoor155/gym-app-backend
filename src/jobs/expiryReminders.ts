import { Prisma } from '@prisma/client';
import prisma from '../db.js';
import { mailEnabled, membershipExpiryMail, sendMail } from '../services/mail.js';

/**
 * Tells members their membership has run out, on the day it does.
 *
 * Runs once a day, but is written so that running it more than once is
 * harmless. That distinction matters more than it sounds: a restart, a
 * redeploy, or a second backend instance all re-run it, and a member who
 * receives the same notice three times learns to ignore the first one next
 * month. `ReminderLog` is what makes the send idempotent rather than merely
 * scheduled — the row is written in the same transaction as the mail, and a
 * duplicate insert is how a second attempt discovers there is nothing to do.
 *
 * Deliberately narrow. It notices memberships expiring *today* and nothing
 * else: no chasing of members who lapsed months ago, no second reminder a week
 * later. Each of those is a decision about how often a gym should email its
 * members, which belongs to the gym rather than to this file.
 */

/** Midnight to midnight for the day a run belongs to. */
const dayBounds = (now: Date): { start: Date; end: Date } => {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

/** Midnight, as a date-only value the `sentOn` column can hold. */
const dayOf = (now: Date): Date => dayBounds(now).start;

export interface ReminderRun {
  /** Memberships expiring today, whether or not anyone could be told. */
  due: number;
  sent: number;
  /** Already handled by an earlier run, or by another instance. */
  skippedAlreadySent: number;
  /** Expiring today, but the member has no address on file. */
  skippedNoEmail: number;
  /** The transport was configured and refused. */
  failed: number;
}

/**
 * Sends today's expiry reminders.
 *
 * `now` is injected so the job is testable without waiting for a date to come
 * round, on the same terms as the membership helpers it sits beside.
 */
export const runExpiryReminders = async (now: Date = new Date()): Promise<ReminderRun> => {
  const { start, end } = dayBounds(now);
  const sentOn = dayOf(now);

  const expiring = await prisma.membership.findMany({
    where: {
      // Only a live membership expiring today. A cancelled or suspended one
      // ending today is not news, and a superseded one has already been
      // replaced by the renewal this mail would be asking for.
      status: 'active',
      expiryDate: { gte: start, lte: end },
    },
    select: {
      id: true,
      gymId: true,
      member: { select: { name: true, email: true, status: true } },
      plan: { select: { name: true } },
      gym: { select: { name: true } },
    },
  });

  const run: ReminderRun = {
    due: expiring.length,
    sent: 0,
    skippedAlreadySent: 0,
    skippedNoEmail: 0,
    failed: 0,
  };

  for (const membership of expiring) {
    const { member } = membership;

    // A member somebody deactivated by hand is not somebody to chase.
    if (member.status !== 'active') continue;

    if (!member.email) {
      run.skippedNoEmail++;
      continue;
    }

    // Claim the send before making it. Doing this first means two instances
    // racing on the same membership have exactly one winner, and the loser
    // finds out here rather than after the member has two copies.
    try {
      await prisma.reminderLog.create({
        data: {
          gymId: membership.gymId,
          membershipId: membership.id,
          kind: 'membershipExpiry',
          sentOn,
          sentTo: member.email,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        run.skippedAlreadySent++;
        continue;
      }
      throw err;
    }

    const ok = await sendMail({
      to: member.email,
      ...membershipExpiryMail(member.name, membership.gym.name, membership.plan.name),
    });

    if (ok) {
      run.sent++;
      continue;
    }

    run.failed++;
    // The claim is given back so tomorrow's run tries again. Keeping it would
    // mean one unreachable mail server silently costs a member their only
    // notice — a duplicate is the cheaper of the two failures here.
    //
    // Only when mail is actually configured: with no transport, `sendMail`
    // logs and reports false every time, and releasing the claim would reprint
    // the same notice on every run for ever.
    if (mailEnabled) {
      await prisma.reminderLog.deleteMany({
        where: { membershipId: membership.id, kind: 'membershipExpiry', sentOn },
      });
    }
  }

  return run;
};
