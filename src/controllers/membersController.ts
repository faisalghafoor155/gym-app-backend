import type { Response } from 'express';
import prisma from '../db.js';
import type { AuthedRequest } from '../types.js';
import type {
  CreateMemberBody, UpdateMemberBody, IdParam, MembershipType,
} from '../schemas.js';

export type MemberStatus = 'active' | 'expiring' | 'expired';

const computeStatus = (endDate: Date): MemberStatus => {
  const now = new Date();
  const end = new Date(endDate);
  const daysLeft = Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  if (daysLeft < 0) return 'expired';
  if (daysLeft <= 7) return 'expiring';
  return 'active';
};

const autoEndDate = (startDate: Date, membershipType: MembershipType): Date => {
  const end = new Date(startDate);
  if (membershipType === 'quarterly') end.setMonth(end.getMonth() + 3);
  else if (membershipType === 'yearly') end.setFullYear(end.getFullYear() + 1);
  else end.setMonth(end.getMonth() + 1); // monthly default
  return end;
};

export const getAll = async (req: AuthedRequest, res: Response): Promise<void> => {
  try {
    const members = await prisma.member.findMany({
      where: { gymId: req.gymId },
      orderBy: { createdAt: 'desc' },
    });
    res.json(members.map(m => ({ ...m, status: computeStatus(m.endDate) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const create = async (
  req: AuthedRequest<Record<string, string>, unknown, CreateMemberBody>,
  res: Response,
): Promise<void> => {
  // Already validated and coerced by the route's schema.
  const { name, email, phone, photo, membershipType, feeAmount, startDate, endDate } = req.body;
  try {
    const resolvedEndDate = endDate ?? autoEndDate(startDate, membershipType ?? 'monthly');

    const member = await prisma.member.create({
      data: {
        gymId: req.gymId,
        name, email, phone, photo,
        membershipType: membershipType ?? 'monthly',
        feeAmount: feeAmount ?? null,
        startDate,
        endDate: resolvedEndDate,
      },
    });
    res.status(201).json({ ...member, status: computeStatus(member.endDate) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const update = async (
  req: AuthedRequest<IdParam, unknown, UpdateMemberBody>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  const { name, email, phone, photo, membershipType, feeAmount, startDate, endDate } = req.body;
  try {
    const existing = await prisma.member.findFirst({ where: { id, gymId: req.gymId } });
    if (!existing) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    const resolvedEndDate = endDate
      ?? (startDate
        ? autoEndDate(startDate, membershipType ?? (existing.membershipType as MembershipType))
        : undefined);

    const member = await prisma.member.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(email !== undefined && { email }),
        ...(phone !== undefined && { phone }),
        ...(photo !== undefined && { photo }),
        ...(membershipType && { membershipType }),
        ...(feeAmount !== undefined && { feeAmount: feeAmount ?? null }),
        ...(startDate && { startDate }),
        ...(resolvedEndDate && { endDate: resolvedEndDate }),
      },
    });
    res.json({ ...member, status: computeStatus(member.endDate) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const remove = async (
  req: AuthedRequest<IdParam>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  try {
    const existing = await prisma.member.findFirst({ where: { id, gymId: req.gymId } });
    if (!existing) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    // Every relation is ON DELETE RESTRICT, so children go first.
    await prisma.memberPlan.deleteMany({ where: { memberId: id } });
    await prisma.attendance.deleteMany({ where: { memberId: id } });
    await prisma.payment.deleteMany({ where: { memberId: id } });
    await prisma.member.delete({ where: { id } });
    res.json({ message: 'Member deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
