import type { Response } from 'express';
import prisma from '../db.js';
import type { AuthedRequest } from '../types.js';

export const getStats = async (req: AuthedRequest, res: Response): Promise<void> => {
  try {
    const now = new Date();
    const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);

    const gymId = req.gymId;
    const [
      totalMembers, activeMembers, expiringMembers,
      todayAttendance, recentMembers, duePayments,
    ] = await Promise.all([
      prisma.member.count({ where: { gymId } }),
      prisma.member.count({ where: { gymId, endDate: { gte: weekFromNow } } }),
      prisma.member.findMany({
        where: { gymId, endDate: { gte: now, lte: weekFromNow } },
        select: { id: true, name: true, phone: true, endDate: true },
      }),
      prisma.attendance.count({
        where: { gymId, checkedInAt: { gte: todayStart, lte: todayEnd } },
      }),
      prisma.member.findMany({
        where: { gymId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true, name: true, phone: true,
          membershipType: true, endDate: true, createdAt: true,
        },
      }),
      prisma.member.count({ where: { gymId, endDate: { lt: now } } }),
    ]);

    res.json({
      totalMembers,
      activeMembers,
      expiringMembers,
      todayAttendance,
      recentMembers,
      duePayments,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
