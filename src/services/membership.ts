import type { MembershipStatus } from '@prisma/client';

/** The window in which a membership is worth warning somebody about. */
export const EXPIRING_SOON_DAYS = 7;

/**
 * How long after expiry a member stops being somebody the gym is still
 * expecting back. Two months of silence is the point at which they belong on
 * an archive list rather than in the day-to-day roster.
 *
 * Like `expiring`, this is never written to a column — it is a function of
 * today's date, so a stored copy would start lying the next morning.
 */
export const LAPSED_AFTER_DAYS = 60;

/**
 * What the front desk needs to see, which is not quite what the database
 * stores: `expiring` is a function of today's date, so it is derived here
 * rather than written to a column that would start lying the next morning.
 */
export type DisplayStatus = MembershipStatus | 'expiring';

export const addDays = (from: Date, days: number): Date => {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d;
};

/**
 * Whole days from now until the date — negative once it has passed.
 *
 * Counted from midnight on both ends: a membership expiring later today has
 * "0 days left", not "0.4", and does not flip to -1 merely because the clock
 * moved past the hour it was sold at.
 */
export const daysUntil = (date: Date, now: Date = new Date()): number => {
  const a = new Date(now); a.setHours(0, 0, 0, 0);
  const b = new Date(date); b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
};

/**
 * The status to show for a membership. A stored status other than `active`
 * always wins — a cancelled membership is cancelled whatever its dates say —
 * and only an active one is measured against the calendar.
 */
export const displayStatus = (
  membership: { status: MembershipStatus; expiryDate: Date },
  now: Date = new Date(),
): DisplayStatus => {
  if (membership.status !== 'active') return membership.status;

  const left = daysUntil(membership.expiryDate, now);
  if (left < 0) return 'expired';
  if (left <= EXPIRING_SOON_DAYS) return 'expiring';
  return 'active';
};

/**
 * Whether a member has been gone long enough to be treated as off the roster:
 * their membership expired, and more than `LAPSED_AFTER_DAYS` have passed
 * since. A membership that is cancelled or suspended is deliberately not
 * lapsed — it ended for a reason somebody recorded, which is a different fact
 * about the member than simply drifting away.
 */
export const isLapsed = (
  membership: { status: MembershipStatus; expiryDate: Date } | null | undefined,
  now: Date = new Date(),
): boolean => {
  // A member who was never sold anything has nothing to have lapsed from.
  if (!membership || membership.status !== 'active') return false;
  return daysUntil(membership.expiryDate, now) < -LAPSED_AFTER_DAYS;
};

/**
 * The status to show for the person, as opposed to the thing they bought.
 *
 * A stored `inactive` always wins: somebody deactivated them by hand, and a
 * renewal must not quietly undo that decision. Otherwise the 60-day rule
 * decides, computed fresh on every read.
 */
export const effectiveMemberStatus = (
  storedStatus: string,
  membership: { status: MembershipStatus; expiryDate: Date } | null | undefined,
  now: Date = new Date(),
): string => {
  if (storedStatus !== 'active') return storedStatus;
  return isLapsed(membership, now) ? 'inactive' : 'active';
};

/** Shape the API returns for a member's current membership. */
export interface MembershipView {
  id: string;
  planId: string;
  planName: string;
  startDate: Date;
  expiryDate: Date;
  originalExpiryDate: Date;
  pricePaid: number;
  durationDays: number;
  extendedDays: number;
  status: DisplayStatus;
  daysLeft: number;
}

type MembershipWithPlan = {
  id: string;
  planId: string;
  startDate: Date;
  expiryDate: Date;
  originalExpiryDate: Date;
  pricePaid: number;
  extendedDays: number;
  status: MembershipStatus;
  plan: { name: string; durationDays: number };
};

/** Decorates a stored membership with the two things only the server can
 *  work out honestly: how it should read today, and how long is left. */
export const toView = (m: MembershipWithPlan, now: Date = new Date()): MembershipView => ({
  id: m.id,
  planId: m.planId,
  planName: m.plan.name,
  startDate: m.startDate,
  expiryDate: m.expiryDate,
  originalExpiryDate: m.originalExpiryDate,
  pricePaid: m.pricePaid,
  durationDays: m.plan.durationDays,
  extendedDays: m.extendedDays,
  status: displayStatus(m, now),
  daysLeft: daysUntil(m.expiryDate, now),
});

/** What counts as a member's membership right now: the newest one that has
 *  not been replaced or called off. */
export const currentMembershipWhere = {
  status: { notIn: ['superseded', 'cancelled'] as MembershipStatus[] },
} as const;

/** Include clause that brings the plan along, which `toView` needs. */
export const withPlan = {
  plan: { select: { name: true, durationDays: true } },
} as const;

/**
 * The default price list a brand-new gym starts with, so the first person to
 * open the plans page is editing prices rather than staring at an empty table.
 * Priced at zero deliberately — a wrong price looks like a real one.
 */
export const DEFAULT_PLANS = [
  { name: 'Monthly', price: 0, durationDays: 30 },
  { name: '3 Months', price: 0, durationDays: 90 },
  { name: 'Yearly', price: 0, durationDays: 365 },
] as const;

/** Formats a gym's counter value as the number people actually say out loud. */
export const formatMemberNo = (seq: number): string => `MEM-${String(seq).padStart(5, '0')}`;
