import type { Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../db.js';
import {
  EXPIRING_SOON_DAYS, LAPSED_AFTER_DAYS, addDays, toView, withPlan,
} from '../services/membership.js';
import { sum } from '../services/money.js';
import type { AuthedRequest } from '../types.js';

const memberSummary = {
  member: { select: { id: true, memberNo: true, name: true, phone: true } },
} as const;

/** How much of the recent past the two charts cover. */
const REVENUE_MONTHS = 6;
const ATTENDANCE_DAYS = 30;

/** Longest follow-up list the dashboard shows before deferring to the full
 *  Members page — a panel nobody scrolls is a panel nobody reads. */
const FOLLOW_UP_LIMIT = 10;

const startOfDay = (d: Date): Date => {
  const c = new Date(d); c.setHours(0, 0, 0, 0); return c;
};

/** First instant of the month `back` months before `from`. */
const startOfMonth = (from: Date, back = 0): Date =>
  new Date(from.getFullYear(), from.getMonth() - back, 1);

/** `2026-08` — the key both the bucketing and the chart agree on, built from
 *  local parts so it does not shift a payment into the wrong month the way
 *  toISOString would for anywhere east of UTC. */
const monthKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

const dayKey = (d: Date): string =>
  `${monthKey(d)}-${String(d.getDate()).padStart(2, '0')}`;

export const getStats = async (req: AuthedRequest, res: Response): Promise<void> => {
  try {
    const now = new Date();
    const soon = addDays(now, EXPIRING_SOON_DAYS);
    // Everything expired within the last 60 days is somebody worth phoning.
    // Past that they are lapsed, and belong on the Members page instead.
    const lapsedBefore = addDays(startOfDay(now), -LAPSED_AFTER_DAYS);
    const todayStart = startOfDay(now);
    const todayEnd = new Date(todayStart); todayEnd.setHours(23, 59, 59, 999);

    const gymId = req.gymId;
    // Money is owner-only, so the queries behind it are not even run for staff.
    const isOwner = req.role === 'owner';

    // Counts run off Membership now that a member's dates live there. Only
    // `active` rows are measured against the calendar — a cancelled or
    // superseded membership is not "expired", it is simply over.
    const live = { gymId, status: 'active' } as const;

    const revenueSince = startOfMonth(now, REVENUE_MONTHS - 1);
    const attendanceSince = addDays(todayStart, -(ATTENDANCE_DAYS - 1));

    const [
      totalMembers, activeMembers, expiringMemberships,
      todayAttendance, recentMembers, duePayments,
      followUpMemberships, lapsedCount,
      attendanceRows, paymentRows, dueAmount, gym,
    ] = await Promise.all([
      prisma.member.count({ where: { gymId } }),
      prisma.membership.count({ where: { ...live, expiryDate: { gt: soon } } }),
      prisma.membership.findMany({
        where: { ...live, expiryDate: { gte: now, lte: soon } },
        include: { ...memberSummary, ...withPlan },
        orderBy: { expiryDate: 'asc' },
      }),
      prisma.attendance.count({
        where: { gymId, checkedInAt: { gte: todayStart, lte: todayEnd } },
      }),
      prisma.member.findMany({
        where: { gymId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true, memberNo: true, name: true, phone: true, createdAt: true,
          memberships: {
            where: { status: { notIn: ['superseded', 'cancelled'] } },
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: withPlan,
          },
        },
      }),
      prisma.membership.count({ where: { ...live, expiryDate: { lt: now } } }),

      // Expired, but not yet lapsed: the renewal-call list.
      prisma.membership.findMany({
        where: { ...live, expiryDate: { gte: lapsedBefore, lt: todayStart } },
        include: { ...memberSummary, ...withPlan },
        orderBy: { expiryDate: 'asc' },
        take: FOLLOW_UP_LIMIT,
      }),
      prisma.membership.count({ where: { ...live, expiryDate: { lt: lapsedBefore } } }),

      prisma.attendance.findMany({
        where: { gymId, checkedInAt: { gte: attendanceSince, lte: todayEnd } },
        select: { checkedInAt: true },
      }),

      isOwner
        ? prisma.payment.findMany({
            where: { gymId, status: 'paid', paymentDate: { gte: revenueSince } },
            // `type` comes along so this month's takings can be split by what
            // they were for, rather than needing a second pass over the same
            // rows.
            select: { amount: true, paymentDate: true, type: true },
          })
        : Promise.resolve([]),
      isOwner
        ? prisma.payment.aggregate({
            where: { gymId, status: 'due' },
            _sum: { amount: true },
          })
        : Promise.resolve(null),

      prisma.gym.findUniqueOrThrow({
        where: { id: gymId },
        select: { createdAt: true },
      }),
    ]);

    // ------------------------------------------------------------- charts

    // Buckets are seeded from the months that actually exist, so a gym three
    // months old gets three bars rather than three bars and three zeroes
    // pretending it was closed.
    const firstMonth = startOfMonth(gym.createdAt) > revenueSince
      ? startOfMonth(gym.createdAt)
      : revenueSince;

    // Accumulated in Decimal, not by adding floats: a month's revenue is the
    // sum of every payment in it, and rounding each addition is how a total
    // ends up a few paisa off the ledger it is supposed to reconcile with.
    const revenueBuckets = new Map<string, Prisma.Decimal>();
    for (let m = new Date(firstMonth); m <= now; m.setMonth(m.getMonth() + 1)) {
      revenueBuckets.set(monthKey(m), new Prisma.Decimal(0));
    }
    for (const p of paymentRows) {
      const k = monthKey(p.paymentDate);
      const bucket = revenueBuckets.get(k);
      if (bucket) {
        revenueBuckets.set(k, bucket.plus(p.amount));
      }
    }
    const revenueByMonth = [...revenueBuckets].map(([month, total]) => ({
      month,
      label: new Date(`${month}-01T00:00:00`).toLocaleDateString('en-PK', { month: 'short' }),
      total: total.toNumber(),
    }));

    // Every day in the window gets a bucket, including the empty ones — a gap
    // in a trend line has to read as "nobody came", not as missing data.
    const attendanceBuckets = new Map<string, number>();
    for (let i = ATTENDANCE_DAYS - 1; i >= 0; i--) {
      attendanceBuckets.set(dayKey(addDays(todayStart, -i)), 0);
    }
    const hourCounts: number[] = Array.from({ length: 24 }, () => 0);
    for (const a of attendanceRows) {
      const k = dayKey(a.checkedInAt);
      if (attendanceBuckets.has(k)) {
        attendanceBuckets.set(k, attendanceBuckets.get(k)! + 1);
      }
      hourCounts[a.checkedInAt.getHours()]! += 1;
    }
    const attendanceByDay = [...attendanceBuckets].map(([date, count]) => ({ date, count }));

    const busiest = hourCounts.reduce(
      (best, count, hour) => (count > best.count ? { hour, count } : best),
      { hour: -1, count: 0 },
    );

    const thisMonth = revenueByMonth.at(-1)?.total ?? 0;
    const lastMonth = revenueByMonth.at(-2)?.total ?? 0;

    // This calendar month broken down by what the money was for: the front desk
    // takes membership fees and supplement money through the same till, and
    // "we made X this month" is only useful next to what made it up.
    //
    // Counted from the 1st rather than the last 30 days — a month-end total
    // that quietly includes part of the previous month is a total nobody can
    // reconcile against their own books.
    const monthStart = startOfMonth(now);
    const monthRows = paymentRows.filter(p => p.paymentDate >= monthStart);
    const byType = (t: 'membership' | 'supplement' | 'other'): number =>
      sum(monthRows.filter(p => p.type === t).map(p => p.amount));

    const monthToDate = {
      from: monthStart,
      to: now,
      membership: byType('membership'),
      supplement: byType('supplement'),
      other: byType('other'),
      // Summed from the rows rather than from the three figures above, so a
      // payment type added later cannot silently drop out of the grand total.
      total: sum(monthRows.map(p => p.amount)),
      count: monthRows.length,
    };

    res.json({
      totalMembers,
      activeMembers,
      expiringMembers: expiringMemberships.map(m => ({
        ...m.member,
        membership: toView(m, now),
      })),
      todayAttendance,
      recentMembers: recentMembers.map(({ memberships, ...m }) => ({
        ...m,
        currentMembership: memberships[0] ? toView(memberships[0], now) : null,
      })),
      duePayments,
      lapsedMembers: lapsedCount,
      followUpMembers: followUpMemberships.map(m => ({
        ...m.member,
        membership: toView(m, now),
      })),
      attendanceByDay,
      // -1 means nobody has checked in at all in the window, which the client
      // shows as "not enough data" rather than as midnight.
      peakHour: busiest.count > 0 ? busiest.hour : null,
      // Revenue keys are absent entirely for staff, not zeroed — a zero would
      // be a number they are not allowed to have, and a wrong one at that.
      ...(isOwner && {
        revenue: {
          thisMonth,
          lastMonth,
          // `_sum` is summed by Postgres in numeric, so it arrives exact and
          // only needs converting for the wire.
          dueTotal: dueAmount?._sum.amount?.toNumber() ?? 0,
          byMonth: revenueByMonth,
          monthToDate,
        },
      }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
