import type { Response } from 'express';
import prisma from '../db.js';
import {
  activeFreeze, addDays, currentMembershipWhere, daysUntil, startOfDay,
} from '../services/membership.js';
import type { AuthedRequest } from '../types.js';
import type { InactiveQuery } from '../schemas.js';

/**
 * Members who are paying but have stopped coming.
 *
 * Only members with a running membership: somebody whose term ran out is the
 * renewals list's business, and somebody frozen was told they could stay
 * away. What is left is the group most likely not to renew — a member who
 * has not been seen for two weeks has usually already decided — and the one
 * a phone call can still change.
 */
export const getInactive = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, InactiveQuery>,
  res: Response,
): Promise<void> => {
  try {
    const gym = await prisma.gym.findUniqueOrThrow({
      where: { id: req.gymId },
      select: { inactivityDays: true },
    });
    const days = req.query.days ?? gym.inactivityDays;
    const now = new Date();
    const today = startOfDay(now);
    const cutoff = addDays(today, -days);

    const members = await prisma.member.findMany({
      where: {
        gymId: req.gymId,
        status: 'active',
        memberships: {
          some: { ...currentMembershipWhere, status: 'active', expiryDate: { gte: today } },
        },
        // Nobody who checked in on or after the cutoff.
        attendance: { none: { checkedInAt: { gte: cutoff } } },
      },
      select: {
        id: true,
        name: true,
        memberNo: true,
        phone: true,
        createdAt: true,
        attendance: { orderBy: { checkedInAt: 'desc' }, take: 1, select: { checkedInAt: true } },
        memberships: {
          where: { ...currentMembershipWhere, status: 'active' },
          orderBy: { startDate: 'desc' },
          take: 1,
          select: {
            startDate: true, expiryDate: true, frozenFrom: true, frozenUntil: true,
            plan: { select: { name: true } },
          },
        },
      },
    });

    const rows = members
      .map(m => {
        const ms = m.memberships[0]!;
        const lastVisit = m.attendance[0]?.checkedInAt ?? null;
        // Never been in: counted from when the membership started, so a
        // member who joined yesterday is not "away for ever".
        const since = lastVisit ?? ms.startDate;
        return {
          id: m.id,
          name: m.name,
          memberNo: m.memberNo,
          phone: m.phone,
          planName: ms.plan.name,
          expiryDate: ms.expiryDate,
          daysLeft: daysUntil(ms.expiryDate, now),
          lastVisit,
          daysAway: Math.max(0, -daysUntil(since, now)),
          frozen: activeFreeze(ms, now) !== null,
        };
      })
      .filter(r => !r.frozen && r.daysAway >= days)
      .sort((a, b) => b.daysAway - a.daysAway)
      .map(({ frozen: _frozen, ...r }) => r);

    res.json({ days, defaultDays: gym.inactivityDays, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
