import type { Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../db.js';
import { audit, diff } from '../services/audit.js';
import { sum, withMoney } from '../services/money.js';
import type { AuthedRequest } from '../types.js';
import type {
  CreateExpenseBody, ExpenseQuery, IdParam, ProfitQuery, UpdateExpenseBody,
} from '../schemas.js';

/**
 * What the gym spends, and what that leaves.
 *
 * Revenue was tracked from the start; this is the other half, and the reason
 * the dashboard can finally answer "did we make anything this month?" rather
 * than only "what came in?".
 */

/** A date's last instant, so `to` includes the whole day the user named. */
const endOfDay = (d: Date): Date => {
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return end;
};

const expenseWhere = (
  gymId: string,
  q: Pick<ExpenseQuery, 'category' | 'search' | 'from' | 'to'>,
): Prisma.ExpenseWhereInput => ({
  gymId,
  ...(q.category && { category: q.category }),
  ...((q.from || q.to) && {
    spentOn: {
      ...(q.from && { gte: q.from }),
      ...(q.to && { lte: endOfDay(q.to) }),
    },
  }),
  // Whatever the owner has to hand: who it was paid to, or what it was for.
  ...(q.search && {
    OR: [
      { vendor: { contains: q.search, mode: 'insensitive' as const } },
      { notes: { contains: q.search, mode: 'insensitive' as const } },
      { category: { contains: q.search, mode: 'insensitive' as const } },
    ],
  }),
});

export const getAll = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, ExpenseQuery>,
  res: Response,
): Promise<void> => {
  const { category, search, from, to, page, limit } = req.query;
  try {
    const where = expenseWhere(req.gymId, { category, search, from, to });

    const [expenses, total, totals, byCategory] = await Promise.all([
      prisma.expense.findMany({
        where,
        include: { recordedBy: { select: { id: true, name: true } } },
        orderBy: { spentOn: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.expense.count({ where }),
      prisma.expense.aggregate({ where, _sum: { amount: true } }),
      // The breakdown is over the whole filtered set, not the current page —
      // a total that changed as you paged through it would be useless.
      prisma.expense.groupBy({
        by: ['category'],
        where,
        _sum: { amount: true },
        orderBy: { _sum: { amount: 'desc' } },
      }),
    ]);

    res.json({
      data: expenses.map((e) => withMoney(e, 'amount')),
      total,
      page,
      limit,
      hasMore: page * limit < total,
      totalSpent: sum([totals._sum.amount]),
      byCategory: byCategory.map((c) => ({
        category: c.category,
        total: sum([c._sum.amount]),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const create = async (
  req: AuthedRequest<Record<string, string>, unknown, CreateExpenseBody>,
  res: Response,
): Promise<void> => {
  const { category, amount, spentOn, vendor, notes } = req.body;
  try {
    const expense = await prisma.expense.create({
      data: {
        gymId: req.gymId,
        category,
        amount,
        spentOn,
        vendor,
        notes,
        recordedById: req.userId,
      },
      include: { recordedBy: { select: { id: true, name: true } } },
    });

    await audit(req, {
      action: 'expense.create',
      entity: 'expense',
      entityId: expense.id,
      entityLabel: `${category} — ${vendor ?? 'no vendor'}`,
      after: { category, amount, spentOn, vendor },
    });

    res.status(201).json(withMoney(expense, 'amount'));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const update = async (
  req: AuthedRequest<IdParam, unknown, UpdateExpenseBody>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  const { category, amount, spentOn, vendor, notes } = req.body;
  try {
    const existing = await prisma.expense.findFirst({ where: { id, gymId: req.gymId } });
    if (!existing) {
      res.status(404).json({ error: 'Expense not found' });
      return;
    }

    const updated = await prisma.expense.update({
      where: { id },
      data: {
        ...(category !== undefined && { category }),
        ...(amount !== undefined && { amount }),
        ...(spentOn !== undefined && { spentOn }),
        ...(vendor !== undefined && { vendor }),
        ...(notes !== undefined && { notes }),
      },
      include: { recordedBy: { select: { id: true, name: true } } },
    });

    const changed = diff(existing, updated, ['category', 'amount', 'spentOn', 'vendor', 'notes']);
    if (changed) {
      await audit(req, {
        action: 'expense.update',
        entity: 'expense',
        entityId: id,
        entityLabel: `${updated.category} — ${updated.vendor ?? 'no vendor'}`,
        before: changed.before,
        after: changed.after,
      });
    }

    res.json(withMoney(updated, 'amount'));
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
    const existing = await prisma.expense.findFirst({ where: { id, gymId: req.gymId } });
    if (!existing) {
      res.status(404).json({ error: 'Expense not found' });
      return;
    }

    await prisma.expense.delete({ where: { id } });

    // The whole row, not a diff: after a delete there is nothing left to look
    // at, so the log is the only remaining record of what was there.
    await audit(req, {
      action: 'expense.delete',
      entity: 'expense',
      entityId: id,
      entityLabel: `${existing.category} — ${existing.vendor ?? 'no vendor'}`,
      before: {
        category: existing.category,
        amount: existing.amount,
        spentOn: existing.spentOn,
        vendor: existing.vendor,
        notes: existing.notes,
      },
    });

    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Money in, money out, and what is left.
 *
 * Only `paid` payments count as revenue: a due is money the gym is owed, not
 * money it has, and counting it would report a profit the bank account does
 * not agree with.
 */
export const getProfit = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, ProfitQuery>,
  res: Response,
): Promise<void> => {
  const { from, to } = req.query;
  try {
    const dateFilter = (field: 'paymentDate' | 'spentOn') =>
      (from || to)
        ? { [field]: { ...(from && { gte: from }), ...(to && { lte: endOfDay(to) }) } }
        : {};

    const [revenue, outstanding, expenses, expensesByCategory, revenueByType] =
      await Promise.all([
        prisma.payment.aggregate({
          where: { gymId: req.gymId, status: 'paid', ...dateFilter('paymentDate') },
          _sum: { amount: true },
        }),
        // Reported alongside, never inside, the profit figure — it is what the
        // gym is owed, which is worth seeing but is not income yet.
        prisma.payment.aggregate({
          where: { gymId: req.gymId, status: 'due', ...dateFilter('paymentDate') },
          _sum: { amount: true },
        }),
        prisma.expense.aggregate({
          where: { gymId: req.gymId, ...dateFilter('spentOn') },
          _sum: { amount: true },
        }),
        prisma.expense.groupBy({
          by: ['category'],
          where: { gymId: req.gymId, ...dateFilter('spentOn') },
          _sum: { amount: true },
          orderBy: { _sum: { amount: 'desc' } },
        }),
        prisma.payment.groupBy({
          by: ['type'],
          where: { gymId: req.gymId, status: 'paid', ...dateFilter('paymentDate') },
          _sum: { amount: true },
        }),
      ]);

    const totalRevenue = sum([revenue._sum.amount]);
    const totalExpenses = sum([expenses._sum.amount]);

    res.json({
      from: from ?? null,
      to: to ?? null,
      revenue: totalRevenue,
      expenses: totalExpenses,
      // Subtracted as numbers, which is exact here: both sides are already
      // rounded to the paisa and are far inside the range where a JS number
      // holds two decimal places without error.
      profit: totalRevenue - totalExpenses,
      outstanding: sum([outstanding._sum.amount]),
      revenueByType: revenueByType.map((r) => ({
        type: r.type,
        total: sum([r._sum.amount]),
      })),
      expensesByCategory: expensesByCategory.map((c) => ({
        category: c.category,
        total: sum([c._sum.amount]),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
