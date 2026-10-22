import type { Response } from 'express';
import prisma from '../db.js';
import type { AuthedRequest } from '../types.js';
import type { SupplementProfitQuery } from '../schemas.js';

/**
 * The shelf's two questions: what is about to run out, and what is actually
 * making money.
 */

/** Products at or below their own low-stock line, emptiest first. */
export const lowStock = async (req: AuthedRequest, res: Response): Promise<void> => {
  try {
    const rows = await prisma.supplement.findMany({
      where: { gymId: req.gymId, stock: { lte: prisma.supplement.fields.lowStockAt } },
      select: { id: true, name: true, category: true, stock: true, lowStockAt: true },
      orderBy: [{ stock: 'asc' }, { name: 'asc' }],
    });
    res.json({ data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Revenue, cost and profit per product over the last `months` months.
 *
 * Cost comes from what each sale recorded at the time, never from today's
 * cost price: a supplier putting prices up must not rewrite last month's
 * margin. Sales made before a cost was ever entered have no cost to count,
 * so they are reported apart rather than counted as pure profit.
 */
export const profit = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, SupplementProfitQuery>,
  res: Response,
): Promise<void> => {
  const { months } = req.query;
  try {
    const since = new Date();
    since.setDate(1);
    since.setHours(0, 0, 0, 0);
    since.setMonth(since.getMonth() - (months - 1));

    const sales = await prisma.supplementSale.findMany({
      where: { gymId: req.gymId, soldAt: { gte: since } },
      select: {
        supplementId: true,
        quantity: true,
        total: true,
        unitCost: true,
        supplement: { select: { name: true, category: true, stock: true } },
      },
    });

    const byProduct = new Map<string, {
      supplementId: string; name: string; category: string; stock: number;
      unitsSold: number; revenue: number; cost: number; costedRevenue: number; uncostedUnits: number;
    }>();

    for (const s of sales) {
      const row = byProduct.get(s.supplementId) ?? {
        supplementId: s.supplementId,
        name: s.supplement.name,
        category: s.supplement.category,
        stock: s.supplement.stock,
        unitsSold: 0, revenue: 0, cost: 0, costedRevenue: 0, uncostedUnits: 0,
      };
      const revenue = s.total.toNumber();
      row.unitsSold += s.quantity;
      row.revenue += revenue;
      if (s.unitCost) {
        row.cost += s.unitCost.toNumber() * s.quantity;
        row.costedRevenue += revenue;
      } else {
        row.uncostedUnits += s.quantity;
      }
      byProduct.set(s.supplementId, row);
    }

    const round = (n: number) => Math.round(n * 100) / 100;
    const data = [...byProduct.values()]
      .map(r => {
        // Profit only over the sales whose cost is known.
        const profitAmount = r.costedRevenue - r.cost;
        return {
          supplementId: r.supplementId,
          name: r.name,
          category: r.category,
          stock: r.stock,
          unitsSold: r.unitsSold,
          revenue: round(r.revenue),
          cost: round(r.cost),
          profit: round(profitAmount),
          marginPct: r.costedRevenue > 0 ? Math.round((profitAmount / r.costedRevenue) * 100) : null,
          uncostedUnits: r.uncostedUnits,
        };
      })
      .sort((a, b) => b.profit - a.profit || b.revenue - a.revenue);

    res.json({
      since,
      months,
      data,
      totals: {
        revenue: round(data.reduce((t, r) => t + r.revenue, 0)),
        cost: round(data.reduce((t, r) => t + r.cost, 0)),
        profit: round(data.reduce((t, r) => t + r.profit, 0)),
        uncostedUnits: data.reduce((t, r) => t + r.uncostedUnits, 0),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
