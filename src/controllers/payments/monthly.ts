/** @format */

import type { Response } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../../db.js";
import { sendCsv, toCsv } from "../../services/csv.js";
import { sum } from "../../services/money.js";
import { channelLabel } from "../../services/paymentChannel.js";
import type { AuthedRequest } from "../../types.js";
import type { MonthlyCollectionQuery } from "../../schemas.js";
import { unpaidForMonth } from "./unpaid.js";

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
  req: AuthedRequest<
    Record<string, string>,
    unknown,
    unknown,
    MonthlyCollectionQuery
  >,
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

    const label = start.toLocaleDateString("en-PK", {
      month: "long",
      year: "numeric",
    });

    // The unpaid side reads memberships, not payments, so it shares nothing
    // with the query below beyond the window and the search term.
    if (view === "unpaid") {
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
      ...(!includeDue && { status: "paid" }),
      ...(search && {
        member: {
          OR: [
            { name: { contains: search, mode: "insensitive" as const } },
            { phone: { contains: search, mode: "insensitive" as const } },
            { memberNo: { contains: search, mode: "insensitive" as const } },
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
        member: {
          select: { id: true, name: true, phone: true, memberNo: true },
        },
        recordedBy: { select: { id: true, name: true } },
      },
      orderBy: { paymentDate: "desc" },
    });

    interface Entry {
      id: string;
      amount: number;
      method: string;
      channel: string | null;
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
      if (p.status === "paid") {
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
        channel: p.channel,
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
    const unpaid =
      view === "all" ? await unpaidForMonth(req.gymId, start, end, search) : [];

    res.json({
      month: month.value,
      label,
      from: start,
      to: end,
      view,
      data: paged.map((r) => ({
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
      collected: sum(
        rows.filter((p) => p.status === "paid").map((p) => p.amount),
      ),
      outstanding: sum(
        rows.filter((p) => p.status === "due").map((p) => p.amount),
      ),
      paymentCount: rows.length,
      shortfallTotal: unpaid.reduce((t, r) => t + r.shortfall, 0),
      expectedTotal: unpaid.reduce((t, r) => t + r.expected, 0),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * A month's collection as a CSV — either side of it, whole.
 *
 * The page pages, at fifty rows a time. Exporting what it holds would produce
 * a file covering fifty of two hundred members with nothing to say so, which
 * is the one direction a figure about money must never be wrong in. So this
 * reads the month again without a page, from the same helpers the page uses,
 * and the totals in the file are totals of the file.
 *
 * The two views are different sheets rather than one with a column for which
 * side a row is on: a debt has no date, method or receipt, and padding it into
 * the paid shape produces a column of blanks that reads as missing data.
 */
export const exportMonthlyCsv = async (
  req: AuthedRequest<
    Record<string, string>,
    unknown,
    unknown,
    MonthlyCollectionQuery
  >,
  res: Response,
): Promise<void> => {
  const { month, search, view, includeDue } = req.query;
  try {
    const start = new Date(month.year, month.month - 1, 1, 0, 0, 0, 0);
    const end = new Date(month.year, month.month, 0, 23, 59, 59, 999);

    if (view === "unpaid") {
      const unpaid = await unpaidForMonth(req.gymId, start, end, search);
      const csv = toCsv(
        [
          "Member No", "Name", "Phone", "Plan",
          "Expires", "Expected", "Paid", "Shortfall",
        ],
        unpaid.map((r) => [
          r.memberNo,
          r.name,
          r.phone ?? "",
          r.membership.planName,
          new Date(r.membership.expiryDate).toISOString().split("T")[0],
          r.expected,
          r.paid,
          r.shortfall,
        ]),
      );
      sendCsv(res, `unpaid-${month.value}.csv`, csv);
      return;
    }

    const rows = await prisma.payment.findMany({
      where: {
        gymId: req.gymId,
        paymentDate: { gte: start, lte: end },
        ...(!includeDue && { status: "paid" }),
        ...(search && {
          member: {
            OR: [
              { name: { contains: search, mode: "insensitive" as const } },
              { phone: { contains: search, mode: "insensitive" as const } },
              { memberNo: { contains: search, mode: "insensitive" as const } },
            ],
          },
        }),
      },
      include: {
        member: { select: { name: true, phone: true, memberNo: true } },
        recordedBy: { select: { name: true } },
      },
      orderBy: { paymentDate: "desc" },
    });

    const csv = toCsv(
      [
        "Date", "Member No", "Member", "Phone",
        "Amount", "For", "Method", "Channel", "Status", "Taken by", "Notes",
      ],
      rows.map((p) => [
        p.paymentDate.toISOString().split("T")[0],
        p.member?.memberNo ?? "",
        p.member?.name ?? "",
        p.member?.phone ?? "",
        p.amount.toString(),
        p.type,
        p.method ?? "",
        channelLabel(p.channel),
        p.status,
        p.recordedBy?.name ?? "",
        p.notes ?? "",
      ]),
    );

    sendCsv(res, `collection-${month.value}.csv`, csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

