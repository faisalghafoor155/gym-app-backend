/** @format */

import type { Response } from "express";
import prisma from "../../db.js";
import { sendCsv, stampedName, toCsv } from "../../services/csv.js";
import { endOfDayUtc } from "../../services/dates.js";
import { toView, withPlan } from "../../services/membership.js";
import { sum } from "../../services/money.js";
import { channelLabel } from "../../services/paymentChannel.js";
import type { AuthedRequest } from "../../types.js";
import type { PaymentQuery } from "../../schemas.js";
import { visibleTo } from "./visibility.js";

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
export const getDue = async (
  req: AuthedRequest,
  res: Response,
): Promise<void> => {
  try {
    const expired = await prisma.membership.findMany({
      where: {
        gymId: req.gymId,
        status: "active",
        expiryDate: { lt: new Date() },
      },
      include: {
        member: {
          select: { id: true, memberNo: true, name: true, phone: true },
        },
        // Only settled money counts towards what a membership has brought in;
        // a row still marked due is the debt, not a payment against it.
        payments: { where: { status: "paid" }, select: { amount: true } },
        ...withPlan,
      },
      orderBy: { expiryDate: "asc" },
    });

    res.json(
      expired.map((m) => {
        const view = toView(m);
        const paid = sum(m.payments.map((p) => p.amount));
        return {
          ...m.member,
          membership: view,
          paid,
          // Never negative: overpaying is not a debt, and a "-500 outstanding"
          // would quietly cancel out somebody else's real one in a total.
          outstanding: Math.max(0, view.pricePaid - paid),
        };
      }),
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * GET /api/payments/export
 * Export all payments matching filters as CSV (streams full dataset)
 */
export const exportCsv = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, PaymentQuery>,
  res: Response,
): Promise<void> => {
  const { status, type, search, from, to } = req.query;
  try {
    const where = {
      gymId: req.gymId,
      ...visibleTo(req),
      ...(status && { status }),
      ...(type && { type }),
      ...((from || to) && {
        paymentDate: {
          ...(from && { gte: from }),
          ...(to && { lte: endOfDayUtc(to) }),
        },
      }),
      // Staff search by whatever they have to hand — a name or a phone.
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

    // Fetch ALL matching payments (no pagination limit)
    const payments = await prisma.payment.findMany({
      where,
      include: {
        member: { select: { name: true, phone: true, memberNo: true } },
        recordedBy: { select: { id: true, name: true } },
      },
      orderBy: { paymentDate: "desc" },
    });

    if (payments.length === 0) {
      res.status(400).json({ error: "No payments to export" });
      return;
    }

    // Build CSV header
    const headers = [
      "Member No",
      "Member",
      "Phone",
      "Amount",
      "For",
      "Method",
      // The point of recording a channel: an export is what gets checked
      // against the wallet's own statement.
      "Channel",
      "Reference",
      "Status",
      "Date",
      "Notes",
    ];
    if (req.role === "owner") {
      headers.push("Taken by");
    }

    // Build CSV rows
    const paymentTypeLabels: { [key: string]: string } = {
      membership: "Membership",
      supplement: "Supplement",
      locker: "Locker",
      other: "Other",
    };

    const rows = payments.map((p) => [
      p.member?.memberNo ?? "",
      p.member?.name ?? "",
      p.member?.phone ?? "",
      p.amount.toString(),
      paymentTypeLabels[p.type] || p.type,
      p.method || "",
      channelLabel(p.channel),
      p.reference ?? "",
      p.status,
      new Date(p.paymentDate).toLocaleDateString(),
      p.notes ?? "",
      ...(req.role === "owner" ? [p.recordedBy?.name ?? ""] : []),
    ]);

    sendCsv(res, stampedName("payments"), toCsv(headers, rows));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to export CSV" });
  }
};
