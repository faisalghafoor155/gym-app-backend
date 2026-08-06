import type { Response } from 'express';
import prisma from '../db.js';
import type { AuthedRequest } from '../types.js';
import type { CreatePaymentBody, PaymentQuery } from '../schemas.js';

export const getAll = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, PaymentQuery>,
  res: Response,
): Promise<void> => {
  const { status } = req.query;
  try {
    const payments = await prisma.payment.findMany({
      where: { gymId: req.gymId, ...(status && { status }) },
      include: { member: { select: { name: true, phone: true } } },
      orderBy: { paymentDate: 'desc' },
    });
    res.json(payments);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const create = async (
  req: AuthedRequest<Record<string, string>, unknown, CreatePaymentBody>,
  res: Response,
): Promise<void> => {
  // Already validated and coerced by the route's schema.
  const { memberId, amount, method, notes, status, paymentDate } = req.body;
  try {
    const member = await prisma.member.findFirst({ where: { id: memberId, gymId: req.gymId } });
    if (!member) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    const payment = await prisma.payment.create({
      data: {
        memberId,
        gymId: req.gymId,
        amount,
        method: method ?? 'cash',
        notes,
        status: status ?? 'paid',
        ...(paymentDate && { paymentDate }),
      },
      include: { member: { select: { name: true, phone: true } } },
    });
    res.status(201).json(payment);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const getDue = async (req: AuthedRequest, res: Response): Promise<void> => {
  try {
    const expiredMembers = await prisma.member.findMany({
      where: { gymId: req.gymId, endDate: { lt: new Date() } },
      select: { id: true, name: true, phone: true, endDate: true },
    });
    res.json(expiredMembers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
