import type { Response } from 'express';
import prisma from '../db.js';
import { audit, diff } from '../services/audit.js';
import { toView, withPlan } from '../services/membership.js';
import type { AuthedRequest } from '../types.js';
import type { CreatePaymentBody, UpdatePaymentBody, PaymentQuery, IdParam } from '../schemas.js';

/** A date filter names a day, not an instant. Without this a payment taken at
 *  2pm falls outside a range that ends on its own date. */
const endOfDay = (d: Date): Date => {
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return end;
};

export const getAll = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, PaymentQuery>,
  res: Response,
): Promise<void> => {
  const { status, search, from, to } = req.query;
  try {
    const payments = await prisma.payment.findMany({
      where: {
        gymId: req.gymId,
        ...(status && { status }),
        ...((from || to) && {
          paymentDate: {
            ...(from && { gte: from }),
            ...(to && { lte: endOfDay(to) }),
          },
        }),
        // Staff search by whatever they have to hand — a name or a phone.
        ...(search && {
          member: {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { phone: { contains: search, mode: 'insensitive' as const } },
              { memberNo: { contains: search, mode: 'insensitive' as const } },
            ],
          },
        }),
      },
      include: { member: { select: { name: true, phone: true, memberNo: true } } },
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
      include: { member: { select: { name: true, phone: true, memberNo: true } } },
    });

    await audit(req, {
      action: 'payment.create',
      entity: 'payment',
      entityId: payment.id,
      entityLabel: `${member.memberNo} · ${member.name} · Rs. ${payment.amount}`,
      after: {
        memberId, amount: payment.amount, method: payment.method,
        status: payment.status, paymentDate: payment.paymentDate,
      },
    });

    res.status(201).json(payment);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Corrects an entry that was recorded wrong. The member it belongs to is fixed;
 * only what was taken, how, when, and whether it has actually been paid.
 */
export const update = async (
  req: AuthedRequest<IdParam, unknown, UpdatePaymentBody>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  const { amount, method, notes, status, paymentDate } = req.body;
  try {
    const existing = await prisma.payment.findFirst({
      where: { id, gymId: req.gymId },
      include: { member: { select: { name: true, memberNo: true } } },
    });
    if (!existing) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    const payment = await prisma.payment.update({
      where: { id },
      data: {
        ...(amount !== undefined && { amount }),
        ...(method && { method }),
        ...(status && { status }),
        ...(notes !== undefined && { notes }),
        ...(paymentDate && { paymentDate }),
      },
      include: { member: { select: { name: true, phone: true, memberNo: true } } },
    });

    const changed = diff(existing, payment, ['amount', 'method', 'status', 'notes', 'paymentDate']);
    if (changed) {
      await audit(req, {
        action: 'payment.update',
        entity: 'payment',
        entityId: payment.id,
        entityLabel: `${existing.member.memberNo} · ${existing.member.name} · Rs. ${payment.amount}`,
        before: changed.before,
        after: changed.after,
      });
    }

    res.json(payment);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/** Removes an entry that should never have existed. The money is gone from the
 *  books, so the audit row carries the whole record rather than a diff. */
export const remove = async (
  req: AuthedRequest<IdParam>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  try {
    const existing = await prisma.payment.findFirst({
      where: { id, gymId: req.gymId },
      include: { member: { select: { name: true, memberNo: true } } },
    });
    if (!existing) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    await prisma.payment.delete({ where: { id } });

    await audit(req, {
      action: 'payment.delete',
      entity: 'payment',
      entityId: existing.id,
      entityLabel: `${existing.member.memberNo} · ${existing.member.name} · Rs. ${existing.amount}`,
      before: {
        memberId: existing.memberId, amount: existing.amount, method: existing.method,
        status: existing.status, notes: existing.notes, paymentDate: existing.paymentDate,
      },
    });

    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/** Members whose current membership has run out — the renewal call list. */
export const getDue = async (req: AuthedRequest, res: Response): Promise<void> => {
  try {
    const expired = await prisma.membership.findMany({
      where: {
        gymId: req.gymId,
        status: 'active',
        expiryDate: { lt: new Date() },
      },
      include: {
        member: { select: { id: true, memberNo: true, name: true, phone: true } },
        ...withPlan,
      },
      orderBy: { expiryDate: 'asc' },
    });

    res.json(expired.map(m => ({
      ...m.member,
      membership: toView(m),
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
