import type { Response } from 'express';
import { Prisma, MembershipStatus } from '@prisma/client';
import prisma from '../db.js';
import { audit, diff } from '../services/audit.js';
import { toView, withPlan } from '../services/membership.js';
import { sum, withMoney } from '../services/money.js';
import type { AuthedRequest } from '../types.js';
import type {
  CreatePaymentBody, UpdatePaymentBody, PaymentQuery, PaymentSummaryQuery,
  MonthlyCollectionQuery, IdParam,
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
 * The members the gym should have been paid by in a given window.
 *
 * A membership counts as belonging to the month if its term overlapped that
 * month at all — started before the month ended, and ran out on or after it
 * began. Overlap rather than "started in" or "expired in", because a member
 * halfway through a three-month term owes for August just as much as one who
 * joined on the 1st, and neither boundary test finds them.
 *
 * `superseded` and `cancelled` terms are left out: the first was replaced by
 * the membership that is being counted instead, so including both would bill
 * the month twice, and the second is a term the gym agreed not to charge for.
 */
const membershipsCovering = (gymId: string, start: Date, end: Date, search?: string) => ({
  gymId,
  startDate: { lte: end },
  expiryDate: { gte: start },
  status: { in: [MembershipStatus.active, MembershipStatus.expired, MembershipStatus.suspended] },
  ...(search && {
    member: {
      OR: [
        { name: { contains: search, mode: 'insensitive' as const } },
        { phone: { contains: search, mode: 'insensitive' as const } },
        { memberNo: { contains: search, mode: 'insensitive' as const } },
      ],
    },
  }),
});

/**
 * Who still owes for the month, and how much.
 *
 * Driven by memberships rather than by payments, which is the whole point: a
 * member who has paid nothing at all has no payment row, so a query over the
 * payments table cannot see them. They are exactly the people this list is for.
 *
 * What counts as paid is every settled payment attached to that membership —
 * not only the ones dated inside the month. A member who paid August's fee in
 * late July has settled it, and a report that called them a defaulter because
 * the receipt fell a few days outside the window would be sending the gym to
 * collect money it already has.
 */
const unpaidForMonth = async (
  gymId: string,
  start: Date,
  end: Date,
  search?: string,
) => {
  const memberships = await prisma.membership.findMany({
    // Spread inline rather than passed as a prepared object: Prisma infers the
    // result type from this call site, and a `where` built elsewhere loses the
    // link between the include and what comes back.
    where: { ...membershipsCovering(gymId, start, end, search) },
    include: {
      member: { select: { id: true, name: true, phone: true, memberNo: true } },
      // Settled money only. A row still marked `due` is the debt itself, so
      // counting it as payment would net the shortfall to zero.
      payments: { where: { status: 'paid' }, select: { amount: true } },
      ...withPlan,
    },
    orderBy: { expiryDate: 'asc' },
  });

  return memberships
    .map(m => {
      const view = toView(m);
      const paid = sum(m.payments.map(p => p.amount));
      return {
        memberId: m.member.id,
        memberNo: m.member.memberNo,
        name: m.member.name,
        phone: m.member.phone,
        membership: view,
        expected: view.pricePaid,
        paid,
        // Never negative: overpaying is not a debt, and a "-500 shortfall"
        // would quietly cancel out somebody else's real one in the total.
        shortfall: Math.max(0, view.pricePaid - paid),
      };
    })
    // Fully settled memberships are not part of an unpaid list. Filtered after
    // the sum rather than in SQL because the comparison is against a total
    // Prisma cannot compute in the same query.
    .filter(r => r.shortfall > 0)
    // Biggest debt first — the order the gym would work the list in.
    .sort((a, b) => b.shortfall - a.shortfall || a.name.localeCompare(b.name));
};

/**
 * Owner-only: one month's collection, member by member.
 *
 * `getSummary` answers "how much did August bring in". This answers "who paid
 * it" — the same money, grouped by the person who handed it over rather than by
 * the month it landed in. The gym's actual question at month end is which
 * members have settled and which have not, and a grand total cannot be read
 * that way round.
 *
 * A member appears once, with everything they paid that month folded together:
 * two instalments of Rs. 1500 read as one member who paid Rs. 3000, not as two
 * strangers who paid Rs. 1500 each. The individual entries ride along so the
 * page can expand a row without going back to the server.
 *
 * `due` rows are counted apart from `paid` ones throughout. Money owed is not
 * money received, and a report that added them together would overstate the
 * month's takings by exactly the amount still missing from the till.
 *
 * The `unpaid` view is a different query against a different table — see
 * `unpaidForMonth`. Both are served from here so the page keeps one month
 * picker, one search box, and one set of totals across the two.
 */
export const getMonthlyCollection = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, MonthlyCollectionQuery>,
  res: Response,
): Promise<void> => {
  const { month, search, view, includeDue, page, limit } = req.query;
  try {
    // Built from local parts, matching how the gym reads a calendar. Month is
    // 1-based in the query and 0-based in Date, hence the shift; passing 0 as
    // the day of the next month is what gives the last day of this one without
    // a leap-year special case.
    const start = new Date(month.year, month.month - 1, 1, 0, 0, 0, 0);
    const end = new Date(month.year, month.month, 0, 23, 59, 59, 999);

    const label = start.toLocaleDateString('en-PK', { month: 'long', year: 'numeric' });

    // The unpaid side reads memberships, not payments, so it shares nothing
    // with the query below beyond the window and the search term.
    if (view === 'unpaid') {
      const all = await unpaidForMonth(req.gymId, start, end, search);
      const paged = all.slice((page - 1) * limit, page * limit);

      res.json({
        month: month.value,
        label,
        from: start,
        to: end,
        view,
        unpaid: paged,
        data: [],
        memberCount: all.length,
        total: all.length,
        page,
        limit,
        hasMore: page * limit < all.length,
        // Totalled over everyone who owes, not over this page — the header
        // must never describe a smaller set than it appears to.
        shortfallTotal: all.reduce((t, r) => t + r.shortfall, 0),
        expectedTotal: all.reduce((t, r) => t + r.expected, 0),
        collected: 0,
        outstanding: 0,
        paymentCount: 0,
      });
      return;
    }

    const where = {
      gymId: req.gymId,
      paymentDate: { gte: start, lte: end },
      ...(!includeDue && { status: 'paid' }),
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

    // Every matching row is read, then grouped in memory. Prisma cannot group
    // by member and return the member's details in one query, and a month's
    // payments for one gym is a small set — this is bounded by how many fees a
    // gym takes in a month, not by how long it has been running.
    const rows = await prisma.payment.findMany({
      where,
      include: {
        member: { select: { id: true, name: true, phone: true, memberNo: true } },
        recordedBy: { select: { id: true, name: true } },
      },
      orderBy: { paymentDate: 'desc' },
    });

    interface Entry {
      id: string;
      amount: number;
      method: string;
      status: string;
      type: string;
      notes: string | null;
      paymentDate: Date;
      recordedBy: { id: string; name: string } | null;
    }
    interface Row {
      memberId: string;
      memberNo: string;
      name: string;
      phone: string | null;
      paid: Prisma.Decimal;
      due: Prisma.Decimal;
      payments: Entry[];
      /** The most recent payment date, so the list can be read newest-first. */
      lastPaymentAt: Date | null;
    }

    const byMember = new Map<string, Row>();
    for (const p of rows) {
      let row = byMember.get(p.memberId);
      if (!row) {
        row = {
          memberId: p.memberId,
          memberNo: p.member.memberNo,
          name: p.member.name,
          phone: p.member.phone,
          paid: new Prisma.Decimal(0),
          due: new Prisma.Decimal(0),
          payments: [],
          lastPaymentAt: null,
        };
        byMember.set(p.memberId, row);
      }
      if (p.status === 'paid') {
        row.paid = row.paid.plus(p.amount);
        // Only settled money dates the row: "last paid" pointing at an unpaid
        // entry would read as a payment that never happened.
        if (!row.lastPaymentAt || p.paymentDate > row.lastPaymentAt) {
          row.lastPaymentAt = p.paymentDate;
        }
      } else {
        row.due = row.due.plus(p.amount);
      }
      row.payments.push({
        id: p.id,
        amount: p.amount.toNumber(),
        method: p.method,
        status: p.status,
        type: p.type,
        notes: p.notes,
        paymentDate: p.paymentDate,
        recordedBy: p.recordedBy,
      });
    }

    // Biggest contributor first — the order the owner reads the month in.
    // Ties break on name so the list is stable between refreshes rather than
    // shuffling rows that happen to have paid the same amount.
    const all = [...byMember.values()].sort((a, b) => {
      const diff = b.paid.comparedTo(a.paid);
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });

    const paged = all.slice((page - 1) * limit, page * limit);

    // `all` carries both halves so the page can show who paid and who did not
    // without a second request — and, more importantly, so the two are read
    // against the same month and the same search rather than drifting apart.
    const unpaid = view === 'all'
      ? await unpaidForMonth(req.gymId, start, end, search)
      : [];

    res.json({
      month: month.value,
      label,
      from: start,
      to: end,
      view,
      data: paged.map(r => ({
        ...r,
        paid: r.paid.toNumber(),
        due: r.due.toNumber(),
        count: r.payments.length,
      })),
      unpaid,
      // Totalled over the whole month, not the page — same rule as the list:
      // a total that silently covered 50 of 200 members would be wrong in the
      // one direction money must never be wrong.
      memberCount: all.length,
      total: all.length,
      page,
      limit,
      hasMore: page * limit < all.length,
      collected: sum(rows.filter(p => p.status === 'paid').map(p => p.amount)),
      outstanding: sum(rows.filter(p => p.status === 'due').map(p => p.amount)),
      paymentCount: rows.length,
      shortfallTotal: unpaid.reduce((t, r) => t + r.shortfall, 0),
      expectedTotal: unpaid.reduce((t, r) => t + r.expected, 0),
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
