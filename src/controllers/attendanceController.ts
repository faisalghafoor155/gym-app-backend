import type { Response } from 'express';
import prisma from '../db.js';
import type { AuthedRequest } from '../types.js';
import type { CheckinBody, IdParam } from '../schemas.js';

const memberSummary = { member: { select: { name: true, phone: true, photo: true } } } as const;

export const checkin = async (
  req: AuthedRequest<Record<string, string>, unknown, CheckinBody>,
  res: Response,
): Promise<void> => {
  const { memberId } = req.body;
  try {
    const member = await prisma.member.findFirst({ where: { id: memberId, gymId: req.gymId } });
    if (!member) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    const record = await prisma.attendance.create({
      data: { memberId, gymId: req.gymId },
      include: memberSummary,
    });
    res.status(201).json(record);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const getToday = async (req: AuthedRequest, res: Response): Promise<void> => {
  try {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const records = await prisma.attendance.findMany({
      where: { gymId: req.gymId, checkedInAt: { gte: start, lte: end } },
      include: memberSummary,
      orderBy: { checkedInAt: 'desc' },
    });
    res.json(records);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const getMemberHistory = async (
  req: AuthedRequest<IdParam>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  try {
    const records = await prisma.attendance.findMany({
      where: { memberId: id, gymId: req.gymId },
      orderBy: { checkedInAt: 'desc' },
      take: 30,
    });
    res.json(records);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
