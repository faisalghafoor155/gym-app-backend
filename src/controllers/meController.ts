import type { Response } from 'express';
import prisma from '../db.js';
import { toView, withPlan } from '../services/membership.js';
import type { AuthedRequest } from '../types.js';

/**
 * Everything a signed-in member can see about themselves. Scoped by the
 * memberId on the session, so a member can only ever read their own record —
 * there is no id in the URL to tamper with.
 */
export const getMyProfile = async (req: AuthedRequest, res: Response): Promise<void> => {
  if (!req.memberId) {
    res.status(404).json({ error: 'This account is not linked to a member record' });
    return;
  }

  try {
    const [member, plan, attendance, payments] = await Promise.all([
      prisma.member.findUnique({
        where: { id: req.memberId },
        select: {
          id: true, memberNo: true, name: true, email: true, phone: true,
          photo: true, gender: true, dateOfBirth: true, address: true,
          emergencyContact: true,
          memberships: {
            where: { status: { notIn: ['superseded', 'cancelled'] } },
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: withPlan,
          },
        },
      }),
      prisma.memberPlan.findFirst({
        where: { memberId: req.memberId },
        include: { workoutPlan: true, dietPlan: true },
        orderBy: { assignedAt: 'desc' },
      }),
      prisma.attendance.findMany({
        where: { memberId: req.memberId },
        orderBy: { checkedInAt: 'desc' },
        take: 30,
      }),
      prisma.payment.findMany({
        where: { memberId: req.memberId },
        orderBy: { paymentDate: 'desc' },
        take: 20,
      }),
    ]);

    if (!member) {
      res.status(404).json({ error: 'Member record not found' });
      return;
    }

    const { memberships, ...profile } = member;

    res.json({
      // Status and days-left come off the membership now; a member with none
      // gets null rather than a fabricated expiry.
      member: {
        ...profile,
        currentMembership: memberships[0] ? toView(memberships[0]) : null,
      },
      plan,
      attendance,
      payments,
      dueTotal: payments.filter(p => p.status === 'due').reduce((sum, p) => sum + p.amount, 0),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
