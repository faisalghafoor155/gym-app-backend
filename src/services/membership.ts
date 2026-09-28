import type { MembershipStatus, Prisma } from '@prisma/client';

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
 * Maximum days an expired membership can still be shown in the default 'All' tab (10 days grace period).
 * After 10 days of expiry, they no longer appear in 'All' and only show under the 'Expired' tab.
 */
export const EXPIRED_GRACE_DAYS_IN_ALL = 10;

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
  pricePaid: number;
  durationDays: number;
  status: DisplayStatus;
  daysLeft: number;
}

type MembershipWithPlan = {
  id: string;
  planId: string;
  startDate: Date;
  expiryDate: Date;
  /** Decimal in the database; `toView` is where it becomes a number. */
  pricePaid: Prisma.Decimal;
  status: MembershipStatus;
  plan: { name: string; durationDays: number };
};

/**
 * When a renewal's new period should begin.
 *
 * The day after the old expiry, so a member who renews with days still on the
 * clock keeps them — paying early must never cost somebody time they already
 * bought. Once the old membership has lapsed there is nothing left to carry,
 * and starting today is right: backdating into the gap would sell the member
 * days that have already gone by.
 */
export const renewalStart = (previousExpiry: Date, now: Date = new Date()): Date => {
  const dayAfter = addDays(previousExpiry, 1);
  return dayAfter > now ? dayAfter : now;
};

/** Decorates a stored membership with the two things only the server can
 *  work out honestly: how it should read today, and how long is left. */
export const toView = (m: MembershipWithPlan, now: Date = new Date()): MembershipView => ({
  id: m.id,
  planId: m.planId,
  planName: m.plan.name,
  startDate: m.startDate,
  expiryDate: m.expiryDate,
  pricePaid: m.pricePaid.toNumber(),
  durationDays: m.plan.durationDays,
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
 * Midnight today, which is the boundary every derived status is measured
 * against. Taken once per request so two rows in the same response can never
 * disagree about where "today" starts.
 */
const startOfDay = (now: Date): Date => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
};

/**
 * A `where` fragment selecting members whose *derived* status matches a filter
 * tab.
 *
 * None of these statuses are stored — `expiring` and `lapsed` are functions of
 * today's date, and a member's effective status depends on the membership
 * hanging off them. Filtering therefore has to be expressed as date arithmetic
 * against the membership table rather than as a column match, which is the
 * whole reason this is not a one-liner.
 *
 * It must agree with `displayStatus`, `isLapsed` and `effectiveMemberStatus`
 * above, and with `memberBucket` on the client. The boundaries are inclusive in
 * the same places they are there: `expiring` runs to the end of day
 * `EXPIRING_SOON_DAYS` out, and lapsing needs *more* than `LAPSED_AFTER_DAYS`
 * to have passed.
 */
export const memberStatusWhere = (
  filter: 'active' | 'expiring' | 'expired' | 'lapsed' | 'none',
  now: Date = new Date(),
): Prisma.MemberWhereInput => {
  const today = startOfDay(now);
  // The newest membership that has not been replaced or called off is the one
  // that decides; `some` over that set is how a member-level filter reaches it.
  const current = (where: Prisma.MembershipWhereInput): Prisma.MemberWhereInput =>
    ({ memberships: { some: { ...currentMembershipWhere, ...where } } });

  // Day EXPIRING_SOON_DAYS from now is still "expiring", so the window ends at
  // the last instant of that day rather than at midnight starting it.
  const soonEnd = addDays(today, EXPIRING_SOON_DAYS + 1);
  // Expired strictly more than LAPSED_AFTER_DAYS ago. An expiry exactly on the
  // boundary has not lapsed yet, matching `< -LAPSED_AFTER_DAYS`.
  const lapsedBefore = addDays(today, -LAPSED_AFTER_DAYS);

  switch (filter) {
    // Deactivated by hand outranks the calendar, so an `inactive` member is
    // never listed as active however healthy their dates look.
    case 'active':
      return {
        status: 'active',
        ...current({ status: 'active', expiryDate: { gte: soonEnd } }),
      };
    case 'expiring':
      return {
        status: 'active',
        ...current({ status: 'active', expiryDate: { gte: today, lt: soonEnd } }),
      };
    // Expired memberships show here
    case 'expired':
      return {
        status: 'active',
        ...current({
          status: 'active',
          expiryDate: { lt: today },
        }),
      };
    // Two ways to be off the roster: deactivated by hand, or gone long enough
    // that the 60-day rule retired them. The client shows both on one tab.
    case 'lapsed':
      return {
        OR: [
          { status: { not: 'active' } },
          {
            status: 'active',
            ...current({ status: 'active', expiryDate: { lt: lapsedBefore } }),
          },
        ],
      };
    // Never sold anything, or holding only a membership that is suspended or
    // otherwise not `active` — neither reads as a live membership on the page.
    case 'none':
      return {
        status: 'active',
        NOT: { memberships: { some: { ...currentMembershipWhere, status: 'active' } } },
      };
  }
};

/** Where clause to find members whose current membership expired more than EXPIRED_GRACE_DAYS_IN_ALL (10) days ago */
export const expiredOverGraceWhere = (now: Date = new Date()): Prisma.MemberWhereInput => {
  const cutoff = addDays(startOfDay(now), -EXPIRED_GRACE_DAYS_IN_ALL);
  return {
    status: 'active',
    memberships: {
      some: {
        ...currentMembershipWhere,
        status: 'active',
        expiryDate: { lt: cutoff },
      },
    },
  };
};

/** Where clause to find recently expired members (expired within the last 10 days) */
export const recentlyExpiredWhere = (now: Date = new Date()): Prisma.MemberWhereInput => {
  const today = startOfDay(now);
  const cutoff = addDays(today, -EXPIRED_GRACE_DAYS_IN_ALL);
  return {
    status: 'active',
    memberships: {
      some: {
        ...currentMembershipWhere,
        status: 'active',
        expiryDate: { lt: today, gte: cutoff },
      },
    },
  };
};

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
