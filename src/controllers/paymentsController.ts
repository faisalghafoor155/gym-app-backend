import type { Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../db.js';
import { audit, diff } from '../services/audit.js';
import { toView, withPlan } from '../services/membership.js';
import { sum, withMoney } from '../services/money.js';
import type { AuthedRequest } from '../types.js';
import type {
  CreatePaymentBody, UpdatePaymentBody, PaymentQuery, PaymentSummaryQuery, IdParam,
} from '../schemas.js';

/** A date filter names a day, not an instant. Without this a payment taken at
 *  2pm falls outside a range that ends on its own date. */
const endOfDay = (d: Date): Date => {
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return end;
};

/**
 * What this request is allowed to see of the payments table.
 *
 * The owner sees the gym's money. Staff see only what they took themselves —
 * enough to check their own counter against their own till, and not the gym's
 * income. Returned as a `where` fragment rather than filtered afterwards so the
 * rows never leave the database in the first place; a post-filter would still
 * have read them, and would be one early `return` away from leaking them.
 *
 * `recordedById: req.userId` also excludes rows with a null recorder — payments
 * predating the column, or whose author has since been deleted. That is the
 * right way round: those are unattributed gym money, which is the owner's to
 * see, not the current staff member's.
 */
const visibleTo = (req: AuthedRequest) =>
  req.role === 'owner' ? {} : { recordedById: req.userId };

/**
 * The payments list, newest first, paged.
 *
 * `collected` and `outstanding` are totalled over everything matching the
 * filters, not over the rows in this page. The page header reads "matching
 * filters", and a total that quietly covered only the first 25 rows while
 * saying that would be wrong in the one direction money must never be wrong.
 * They are grouped in the database for the same reason: summing a page in the
 * client can only ever total the page.
 */
export const getAll = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, PaymentQuery>,
  res: Response,
): Promise<void> => {
  const { status, type, search, from, to, page, limit } = req.query;
  try {
    const where = {
      gymId: req.gymId,
      ...visibleTo(req),
      ...(status && { status }),
      ...(type && { type }),
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
    };

    const [payments, total, totals] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: {
          member: { select: { name: true, phone: true, memberNo: true } },
          // Shown to the owner as "who took this". Staff see only their own
          // rows, so it tells them nothing they did not already know.
          recordedBy: { select: { id: true, name: true } },
        },
        orderBy: { paymentDate: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.payment.count({ where }),
      prisma.payment.groupBy({
        by: ['status'],
        where,
        _sum: { amount: true },
      }),
    ]);

    // groupBy omits a status entirely when nothing matches it. `sum` treats a
    // missing value as zero, so an absent group needs no special case.
    const totalFor = (s: string): number =>
      sum(totals.filter(t => t.status === s).map(t => t._sum.amount));

    res.json({
      data: payments.map(p => withMoney(p, 'amount')),
      total,
      page,
      limit,
      hasMore: page * limit < total,
      collected: totalFor('paid'),
      outstanding: totalFor('due'),
    });
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
  const { memberId, amount, method, notes, status, type, membershipId, paymentDate } = req.body;
  try {
    const member = await prisma.member.findFirst({ where: { id: memberId, gymId: req.gymId } });
    if (!member) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    // A payment may only be attached to a membership this gym sold to this
    // member. Without the memberId check a valid id from the same gym would
    // let one member's payment settle another's membership.
    if (membershipId) {
      const membership = await prisma.membership.findFirst({
        where: { id: membershipId, gymId: req.gymId, memberId },
        select: { id: true },
      });
      if (!membership) {
        res.status(404).json({ error: 'Membership not found for this member' });
        return;
      }
    }

    const payment = await prisma.payment.create({
      data: {
        memberId,
        gymId: req.gymId,
        amount,
        method: method ?? 'cash',
        notes,
        status: status ?? 'paid',
        type: type ?? 'membership',
        membershipId: membershipId ?? null,
        // Stamped from the session, never from the body: a staff member must
        // not be able to file their takings under somebody else's name.
        recordedById: req.userId,
        ...(paymentDate && { paymentDate }),
      },
      include: {
        member: { select: { name: true, phone: true, memberNo: true } },
        recordedBy: { select: { id: true, name: true } },
      },
    });

    await audit(req, {
      action: 'payment.create',
      entity: 'payment',
      entityId: payment.id,
      entityLabel: `${member.memberNo} · ${member.name} · Rs. ${payment.amount}`,
      after: {
        memberId, amount: payment.amount.toNumber(), method: payment.method,
        status: payment.status, type: payment.type,
        membershipId: payment.membershipId, paymentDate: payment.paymentDate,
      },
    });

    res.status(201).json(withMoney(payment, 'amount'));
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
  const { amount, method, notes, status, type, membershipId, paymentDate } = req.body;
  try {
    const existing = await prisma.payment.findFirst({
      where: { id, gymId: req.gymId },
      include: { member: { select: { name: true, memberNo: true } } },
    });
    if (!existing) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    // Same rule as create: the membership has to be one this gym sold to the
    // member the payment already belongs to. The member itself is not editable,
    // so `existing.memberId` is the right thing to check against.
    if (membershipId) {
      const membership = await prisma.membership.findFirst({
        where: { id: membershipId, gymId: req.gymId, memberId: existing.memberId },
        select: { id: true },
      });
      if (!membership) {
        res.status(404).json({ error: 'Membership not found for this member' });
        return;
      }
    }

    const payment = await prisma.payment.update({
      where: { id },
      data: {
        ...(amount !== undefined && { amount }),
        ...(method && { method }),
        ...(status && { status }),
        ...(type && { type }),
        // Explicit null clears the link, which is how a payment logged against
        // the wrong membership gets corrected.
        ...(membershipId !== undefined && { membershipId: membershipId ?? null }),
        ...(notes !== undefined && { notes }),
        ...(paymentDate && { paymentDate }),
      },
      include: {
        member: { select: { name: true, phone: true, memberNo: true } },
        // Left as it was: correcting an entry does not change who took the
        // money, and reassigning it to the owner doing the correction would
        // quietly rewrite whose takings it was.
        recordedBy: { select: { id: true, name: true } },
      },
    });

    const changed = diff(existing, payment, [
      'amount', 'method', 'status', 'type', 'membershipId', 'notes', 'paymentDate',
    ]);
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

    res.json(withMoney(payment, 'amount'));
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
        memberId: existing.memberId, amount: existing.amount.toNumber(), method: existing.method,
        status: existing.status, type: existing.type, membershipId: existing.membershipId,
        notes: existing.notes, paymentDate: existing.paymentDate,
      },
    });

    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

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
  req: AuthedRequest<Record<string, string>, unknown, unknown, PaymentSummaryQuery>,
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
          status: 'paid',
          paymentDate: { gte: since },
        },
        select: { amount: true, paymentDate: true, type: true },
      }),
      // Outstanding is the whole ledger, not just this window — money owed from
      // four months ago is still owed today.
      prisma.payment.aggregate({
        where: { gymId: req.gymId, status: 'due' },
        _sum: { amount: true },
        _count: true,
      }),
    ]);

    // Local parts, matching how the gym reads a date. Building the key from
    // toISOString would bucket a late-evening payment into the next month for
    // any timezone ahead of UTC.
    const monthKey = (d: Date): string =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

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
      const d = new Date(now.getFullYear(), now.getMonth() - (months - 1) + i, 1);
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
      label: new Date(`${month}-01T00:00:00`)
        .toLocaleDateString('en-PK', { month: 'short', year: 'numeric' }),
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
      grandTotal: sum(rows.map(p => p.amount)),
      count: rows.length,
      thisMonth: byMonth.at(-1)?.total ?? 0,
      lastMonth: byMonth.at(-2)?.total ?? 0,
      dueTotal: dueAgg._sum.amount?.toNumber() ?? 0,
      dueCount: dueAgg._count,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * The renewal call list: members whose current membership has run out.
 *
 * Now that payments name the membership they settled, each entry also carries
 * what that membership actually brought in — `paid` against `pricePaid`, and
 * the shortfall between them. Expiry alone never meant "owes money": a member
 * can be a month overdue and fully paid up, or inside their term and still
 * owing half the fee. The two facts are reported separately rather than one
 * being used as a stand-in for the other.
 */
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
        // Only settled money counts towards what a membership has brought in;
        // a row still marked due is the debt, not a payment against it.
        payments: { where: { status: 'paid' }, select: { amount: true } },
        ...withPlan,
      },
      orderBy: { expiryDate: 'asc' },
    });

    res.json(expired.map(m => {
      const view = toView(m);
      const paid = sum(m.payments.map(p => p.amount));
      return {
        ...m.member,
        membership: view,
        paid,
        // Never negative: overpaying is not a debt, and a "-500 outstanding"
        // would quietly cancel out somebody else's real one in a total.
        outstanding: Math.max(0, view.pricePaid - paid),
      };
    }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
