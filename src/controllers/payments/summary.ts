/** @format */

import type { Response } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../../db.js";
import { sum } from "../../services/money.js";
import type { AuthedRequest } from "../../types.js";
import type { PaymentSummaryQuery } from "../../schemas.js";

/**
 * Owner-only: the gym's takings, month by month.
 *
 * Broken down by what the money was for, because membership fees and supplement
 * money come through the same till and a single grand total cannot be
 * reconciled against anything. Same window and month shape as the supplement
 * sales report, so the two pages line up month for month.
 *
 * Counted from the 1st of each calendar month rather than as a rolling window:
 * a month-end figure that quietly includes part of the previous month is a
 * figure nobody can check against their own books.
 *
 * Only settled money is counted. A row still marked `due` is a debt the gym is
 * owed, not income it has received, so it is reported separately as `dueTotal`
 * instead of being folded into the totals.
 */
export const getSummary = async (
  req: AuthedRequest<
    Record<string, string>,
    unknown,
    unknown,
    PaymentSummaryQuery
  >,
  res: Response,
): Promise<void> => {
  const { months } = req.query;
  try {
    const now = new Date();
    const since = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);

    const [rows, dueAgg] = await Promise.all([
      prisma.payment.findMany({
        where: {
          gymId: req.gymId,
          status: "paid",
          paymentDate: { gte: since },
        },
        select: { amount: true, paymentDate: true, type: true },
      }),
      // Outstanding is the whole ledger, not just this window — money owed from
      // four months ago is still owed today.
      prisma.payment.aggregate({
        where: { gymId: req.gymId, status: "due" },
        _sum: { amount: true },
        _count: true,
      }),
    ]);

    // Local parts, matching how the gym reads a date. Building the key from
    // toISOString would bucket a late-evening payment into the next month for
    // any timezone ahead of UTC.
    const monthKey = (d: Date): string =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

    type Bucket = {
      membership: Prisma.Decimal;
      supplement: Prisma.Decimal;
      other: Prisma.Decimal;
      total: Prisma.Decimal;
      count: number;
    };
    const empty = (): Bucket => ({
      membership: new Prisma.Decimal(0),
      supplement: new Prisma.Decimal(0),
      other: new Prisma.Decimal(0),
      total: new Prisma.Decimal(0),
      count: 0,
    });

    // Seeded so a month the gym took nothing still appears, as a zero rather
    // than a gap — a missing bar reads as "no data", which is a different claim.
    const buckets = new Map<string, Bucket>();
    for (let i = 0; i < months; i++) {
      const d = new Date(
        now.getFullYear(),
        now.getMonth() - (months - 1) + i,
        1,
      );
      buckets.set(monthKey(d), empty());
    }

    for (const p of rows) {
      const b = buckets.get(monthKey(p.paymentDate));
      if (!b) continue;
      b[p.type] = b[p.type].plus(p.amount);
      // Accumulated from the row, not from the three figures above, so a
      // payment type added later cannot silently drop out of the grand total.
      b.total = b.total.plus(p.amount);
      b.count += 1;
    }

    const byMonth = [...buckets].map(([month, b]) => ({
      month,
      label: new Date(`${month}-01T00:00:00`).toLocaleDateString("en-PK", {
        month: "short",
        year: "numeric",
      }),
      membership: b.membership.toNumber(),
      supplement: b.supplement.toNumber(),
      other: b.other.toNumber(),
      total: b.total.toNumber(),
      count: b.count,
    }));

    res.json({
      months,
      from: since,
      to: now,
      byMonth,
      // The window's own totals, so the page's header and its rows can never
      // disagree about the period they describe.
      grandTotal: sum(rows.map((p) => p.amount)),
      count: rows.length,
      thisMonth: byMonth.at(-1)?.total ?? 0,
      lastMonth: byMonth.at(-2)?.total ?? 0,
      dueTotal: dueAgg._sum.amount?.toNumber() ?? 0,
      dueCount: dueAgg._count,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

