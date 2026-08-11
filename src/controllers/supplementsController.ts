import type { Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../db.js';
import { audit } from '../services/audit.js';
import { sum, withMoney } from '../services/money.js';
import type { AuthedRequest } from '../types.js';
import type {
  CreateSupplementBody, UpdateSupplementBody, SellSupplementBody,
  RestockSupplementBody, SalesReportQuery, IdParam,
} from '../schemas.js';

/** Thrown when the guarded decrement finds the stock already gone, so the
 *  transaction rolls back instead of overselling. */
class OutOfStockError extends Error {}

export const getAll = async (req: AuthedRequest, res: Response): Promise<void> => {
  try {
    const supplements = await prisma.supplement.findMany({
      where: { gymId: req.gymId },
      orderBy: { createdAt: 'desc' },
    });
    res.json(supplements.map(s => withMoney(s, 'price')));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const create = async (
  req: AuthedRequest<Record<string, string>, unknown, CreateSupplementBody>,
  res: Response,
): Promise<void> => {
  // Already validated and coerced by the route's schema.
  const { name, category, description, dosage, timing, price, stock } = req.body;
  try {
    const supplement = await prisma.supplement.create({
      data: {
        gymId: req.gymId,
        name, category,
        description: description ?? null,
        dosage: dosage ?? null,
        timing: timing ?? null,
        price: price ?? null,
        stock: stock ?? 0,
      },
    });
    res.status(201).json(withMoney(supplement, 'price'));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const update = async (
  req: AuthedRequest<IdParam, unknown, UpdateSupplementBody>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  const { name, category, description, dosage, timing, price, stock } = req.body;
  try {
    const existing = await prisma.supplement.findFirst({ where: { id, gymId: req.gymId } });
    if (!existing) {
      res.status(404).json({ error: 'Supplement not found' });
      return;
    }

    const supplement = await prisma.supplement.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(category && { category }),
        ...(description !== undefined && { description }),
        ...(dosage !== undefined && { dosage }),
        ...(timing !== undefined && { timing }),
        ...(price !== undefined && { price: price ?? null }),
        ...(stock !== undefined && { stock: stock ?? 0 }),
      },
    });
    res.json(withMoney(supplement, 'price'));
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
    const existing = await prisma.supplement.findFirst({ where: { id, gymId: req.gymId } });
    if (!existing) {
      res.status(404).json({ error: 'Supplement not found' });
      return;
    }
    await prisma.supplement.delete({ where: { id } });
    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Sells stock across the counter.
 *
 * The sale row, the stock decrement and the payment are written in one
 * transaction: a sale that took the money without moving the stock, or moved
 * the stock without recording the money, is worse than one that failed
 * outright and can simply be retried.
 *
 * The unit price comes from the supplement rather than the request — the same
 * rule membership expiry follows, and for the same reason.
 */
export const sell = async (
  req: AuthedRequest<IdParam, unknown, SellSupplementBody>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  const { quantity, memberId, notes, soldAt } = req.body;
  try {
    const supplement = await prisma.supplement.findFirst({ where: { id, gymId: req.gymId } });
    if (!supplement) {
      res.status(404).json({ error: 'Supplement not found' });
      return;
    }
    if (supplement.price == null) {
      res.status(400).json({ error: 'Set a price for this supplement before selling it' });
      return;
    }
    if (supplement.stock < quantity) {
      res.status(400).json({
        error: supplement.stock === 0
          ? 'That supplement is out of stock'
          : `Only ${supplement.stock} in stock`,
      });
      return;
    }

    // A walk-in has no member; a named buyer must be one of this gym's.
    let member: { id: string; name: string; memberNo: string } | null = null;
    if (memberId) {
      member = await prisma.member.findFirst({
        where: { id: memberId, gymId: req.gymId },
        select: { id: true, name: true, memberNo: true },
      });
      if (!member) {
        res.status(404).json({ error: 'Member not found' });
        return;
      }
    }

    const unitPrice = supplement.price;
    const total = unitPrice.times(quantity);
    const when = soldAt ?? new Date();

    const sale = await prisma.$transaction(async (tx) => {
      // Guarded decrement: the `stock: { gte: quantity }` filter is what makes
      // two tills selling the last tub at the same moment impossible. The
      // check above is for a good error message; this is what enforces it.
      const claimed = await tx.supplement.updateMany({
        where: { id: supplement.id, gymId: req.gymId, stock: { gte: quantity } },
        data: { stock: { decrement: quantity } },
      });
      if (claimed.count === 0) {
        throw new OutOfStockError();
      }

      // Only a member's purchase becomes a Payment — the books hang money off
      // a member, and a walk-in has none to hang it off. The sale row still
      // records what was taken either way.
      const payment = member
        ? await tx.payment.create({
            data: {
              gymId: req.gymId,
              memberId: member.id,
              amount: total,
              method: 'cash',
              status: 'paid',
              type: 'supplement',
              paymentDate: when,
              notes: `${supplement.name} x${quantity}`,
              // Whoever rang up the sale took the money, same as a fee at the
              // counter — so it shows in their own payments list rather than
              // appearing from nowhere.
              recordedById: req.userId,
            },
          })
        : null;

      return tx.supplementSale.create({
        data: {
          gymId: req.gymId,
          supplementId: supplement.id,
          memberId: member?.id ?? null,
          quantity,
          unitPrice,
          total,
          paymentId: payment?.id ?? null,
          soldAt: when,
          notes,
        },
        include: { supplement: { select: { name: true, stock: true } } },
      });
    });

    await audit(req, {
      action: 'supplement.sell',
      entity: 'supplementSale',
      entityId: sale.id,
      entityLabel: `${supplement.name} x${quantity}${member ? ` · ${member.memberNo} ${member.name}` : ' · walk-in'}`,
      after: {
        supplementId: supplement.id,
        quantity,
        unitPrice: unitPrice.toNumber(),
        total: total.toNumber(),
        memberId: member?.id ?? null,
        stockAfter: sale.supplement.stock,
      },
    });

    res.status(201).json({
      ...withMoney(sale, 'unitPrice', 'total'),
      stockLeft: sale.supplement.stock,
    });
  } catch (err) {
    if (err instanceof OutOfStockError) {
      res.status(409).json({ error: 'Not enough stock left — someone just sold it' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/** Stock arriving from a supplier. An event with a reason, rather than a
 *  silent edit to the number on the shelf. */
export const restock = async (
  req: AuthedRequest<IdParam, unknown, RestockSupplementBody>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  const { quantity, notes } = req.body;
  try {
    const existing = await prisma.supplement.findFirst({ where: { id, gymId: req.gymId } });
    if (!existing) {
      res.status(404).json({ error: 'Supplement not found' });
      return;
    }

    const supplement = await prisma.supplement.update({
      where: { id },
      data: { stock: { increment: quantity } },
    });

    await audit(req, {
      action: 'supplement.restock',
      entity: 'supplement',
      entityId: id,
      entityLabel: `${existing.name} +${quantity}`,
      before: { stock: existing.stock },
      after: { stock: supplement.stock, added: quantity },
      reason: notes ?? null,
    });

    res.json(withMoney(supplement, 'price'));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Sales history, bucketed by month.
 *
 * Every month in the window gets a row, including the empty ones — a gap in a
 * report reads as missing data, while an explicit zero reads as a quiet month.
 */
export const salesReport = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, SalesReportQuery>,
  res: Response,
): Promise<void> => {
  const { months } = req.query;
  try {
    const now = new Date();
    // Start at midnight on the 1st, `months - 1` back, so the window covers
    // whole months including this one rather than a rolling window that cuts
    // the oldest month in half.
    const since = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);

    const sales = await prisma.supplementSale.findMany({
      where: { gymId: req.gymId, soldAt: { gte: since } },
      include: {
        supplement: { select: { id: true, name: true } },
        member: { select: { name: true, memberNo: true } },
      },
      orderBy: { soldAt: 'desc' },
    });

    const monthKey = (d: Date): string =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

    // Seeded so a month with no sales still appears.
    const buckets = new Map<string, { revenue: Prisma.Decimal; units: number; sales: number }>();
    for (let i = 0; i < months; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - (months - 1) + i, 1);
      buckets.set(monthKey(d), { revenue: new Prisma.Decimal(0), units: 0, sales: 0 });
    }

    // Per-product totals across the whole window: what actually sells.
    const byProduct = new Map<string, { name: string; units: number; revenue: Prisma.Decimal }>();

    for (const s of sales) {
      const bucket = buckets.get(monthKey(s.soldAt));
      if (bucket) {
        bucket.revenue = bucket.revenue.plus(s.total);
        bucket.units += s.quantity;
        bucket.sales += 1;
      }

      const p = byProduct.get(s.supplementId)
        ?? { name: s.supplement.name, units: 0, revenue: new Prisma.Decimal(0) };
      p.units += s.quantity;
      p.revenue = p.revenue.plus(s.total);
      byProduct.set(s.supplementId, p);
    }

    res.json({
      byMonth: [...buckets].map(([month, b]) => ({
        month,
        label: new Date(`${month}-01T00:00:00`)
          .toLocaleDateString('en-PK', { month: 'short', year: 'numeric' }),
        revenue: b.revenue.toNumber(),
        units: b.units,
        sales: b.sales,
      })),
      byProduct: [...byProduct]
        .map(([id, p]) => ({ id, name: p.name, units: p.units, revenue: p.revenue.toNumber() }))
        .sort((a, b) => b.revenue - a.revenue),
      totalRevenue: sum(sales.map(s => s.total)),
      totalUnits: sales.reduce((n, s) => n + s.quantity, 0),
      recent: sales.slice(0, 50).map(s => ({
        ...withMoney(s, 'unitPrice', 'total'),
        supplementName: s.supplement.name,
        buyer: s.member ? `${s.member.memberNo} · ${s.member.name}` : 'Walk-in',
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
