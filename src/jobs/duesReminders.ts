import { Prisma } from '@prisma/client';
import prisma from '../db.js';
import { membershipBalances, type MembershipBalance } from '../services/balances.js';
import { addDays, LAPSED_AFTER_DAYS, startOfDay } from '../services/membership.js';
import { canWhatsApp } from '../services/phone.js';
import { planHasFeature } from '../services/subscription.js';
import { templates } from '../services/whatsapp.js';
import { messagingEnabled, sendMemberMessage } from '../services/messaging.js';

/**
 * Reminds members who still owe part of their membership fee.
 *
 * At most once every `EVERY_DAYS` days per membership — a weekly nudge, not a
 * daily one. A member who owes Rs. 2,000 and is told so every morning stops
 * reading the gym's messages, including the expiry notice that actually needs
 * reading.
 *
 * WhatsApp only. The expiry notice goes both ways because missing it costs the
 * member their access; this one costs nothing to miss once, and an email
 * nobody opens is not worth the duplicate.
 *
 * Idempotent the same way the expiry job is: a ReminderLog row is claimed
 * before the send, and two runs on the same day collide on its unique key.
 */

/** Days between reminders for one membership. Zero turns the job off. */
const EVERY_DAYS = Number(process.env.DUES_REMINDER_EVERY_DAYS ?? 7);

export interface DuesRun {
  /** Current memberships with money still owed, across every gym. */
  owing: number;
  sent: number;
  /** Reminded within the last `EVERY_DAYS` days. */
  skippedRecently: number;
  /** Already claimed today, by an earlier run or another instance. */
  skippedAlreadySent: number;
  /** No number WhatsApp can reach, or the member opted out. */
  skippedNoWhatsApp: number;
  failed: number;
}

const emptyRun = (): DuesRun => ({
  owing: 0,
  sent: 0,
  skippedRecently: 0,
  skippedAlreadySent: 0,
  skippedNoWhatsApp: 0,
  failed: 0,
});

const claim = async (b: MembershipBalance, sentOn: Date, sentTo: string): Promise<boolean> => {
  try {
    await prisma.reminderLog.create({
      data: {
        gymId: b.gymId,
        membershipId: b.membershipId,
        kind: 'duesOutstanding',
        channel: 'whatsapp',
        sentOn,
        sentTo,
      },
    });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false;
    throw err;
  }
};

export const runDuesReminders = async (now: Date = new Date()): Promise<DuesRun> => {
  const run = emptyRun();
  const today = startOfDay(now);

  // Somebody gone long enough to have lapsed is off the roster; chasing them
  // for a balance belongs to a phone call, not an automated message.
  const balances = await membershipBalances(
    { expiryDate: { gte: addDays(today, -LAPSED_AFTER_DAYS) } },
    now,
  );
  run.owing = balances.length;

  // Not configured, or configured off, is not failing to send.
  if (EVERY_DAYS <= 0 || !messagingEnabled() || balances.length === 0) return run;

  // One query for "who was reminded recently", rather than one per member.
  const recent = await prisma.reminderLog.findMany({
    where: {
      membershipId: { in: balances.map(b => b.membershipId) },
      kind: 'duesOutstanding',
      channel: 'whatsapp',
      sentOn: { gt: addDays(today, -EVERY_DAYS) },
    },
    select: { membershipId: true },
  });
  const remindedRecently = new Set(recent.map(r => r.membershipId));

  for (const b of balances) {
    if (b.member.status !== 'active') continue;
    if (!planHasFeature(b.gym.plan, 'whatsapp')) continue;

    if (b.member.whatsappOptOut || !canWhatsApp(b.member.phone)) {
      run.skippedNoWhatsApp++;
      continue;
    }
    if (remindedRecently.has(b.membershipId)) {
      run.skippedRecently++;
      continue;
    }
    if (!(await claim(b, today, b.member.phone!))) {
      run.skippedAlreadySent++;
      continue;
    }

    const result = await sendMemberMessage({
      to: b.member.phone!,
      ...templates.duesReminder(
        b.member.name,
        b.gym.name,
        `Rs. ${b.outstanding.toLocaleString('en-PK')}`,
        b.membership.planName,
      ),
    });

    if (result === 'sent') {
      run.sent++;
      continue;
    }

    run.failed++;
    // Given back so tomorrow's run tries again, as the expiry job does: one
    // refusal must not silently push the next reminder a week out.
    await prisma.reminderLog.deleteMany({
      where: {
        membershipId: b.membershipId, kind: 'duesOutstanding', channel: 'whatsapp', sentOn: today,
      },
    });
  }

  return run;
};
