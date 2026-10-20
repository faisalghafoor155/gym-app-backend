/** @format */

import type { Response } from "express";
import prisma from "../../db.js";
import { audit, diff } from "../../services/audit.js";
import { endOfDayUtc } from "../../services/dates.js";
import { sum, withMoney } from "../../services/money.js";
import { notifyPaymentReceipt } from "../../services/memberNotifications.js";
import type { AuthedRequest } from "../../types.js";
import type {
  CreatePaymentBody,
  UpdatePaymentBody,
  PaymentQuery,
  IdParam,
} from "../../schemas.js";
import { visibleTo } from "./visibility.js";

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

    const [payments, total, totals] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: {
          member: { select: { name: true, phone: true, memberNo: true } },
          // Shown to the owner as "who took this". Staff see only their own
          // rows, so it tells them nothing they did not already know.
          recordedBy: { select: { id: true, name: true } },
        },
        orderBy: { paymentDate: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.payment.count({ where }),
      prisma.payment.groupBy({
        by: ["status"],
        where,
        _sum: { amount: true },
      }),
    ]);

    // groupBy omits a status entirely when nothing matches it. `sum` treats a
    // missing value as zero, so an absent group needs no special case.
    const totalFor = (s: string): number =>
      sum(totals.filter((t) => t.status === s).map((t) => t._sum.amount));

    res.json({
      data: payments.map((p) => withMoney(p, "amount")),
      total,
      page,
      limit,
      hasMore: page * limit < total,
      collected: totalFor("paid"),
      outstanding: totalFor("due"),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

export const create = async (
  req: AuthedRequest<Record<string, string>, unknown, CreatePaymentBody>,
  res: Response,
): Promise<void> => {
  // Already validated and coerced by the route's schema.
  const {
    memberId,
    amount,
    method,
    notes,
    status,
    type,
    membershipId,
    paymentDate,
    channel,
    reference,
  } = req.body;
  try {
    const member = await prisma.member.findFirst({
      where: { id: memberId, gymId: req.gymId },
    });
    if (!member) {
      res.status(404).json({ error: "Member not found" });
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
        res.status(404).json({ error: "Membership not found for this member" });
        return;
      }
    }

    const payment = await prisma.payment.create({
      data: {
        memberId,
        gymId: req.gymId,
        amount,
        method: method ?? "cash",
        // Cash has no channel. The schema rejects the contradiction outright;
        // this drops it for the default-to-cash path, where no method was sent
        // at all.
        channel: (method ?? "cash") === "cash" ? null : channel ?? null,
        reference: reference ?? null,
        notes,
        status: status ?? "paid",
        type: type ?? "membership",
        membershipId: membershipId ?? null,
        // Stamped from the session, never from the body: a staff member must
        // not be able to file their takings under somebody else's name.
        recordedById: req.userId,
        ...(paymentDate && { paymentDate }),
      },
      include: {
        member: {
          select: {
            name: true, phone: true, memberNo: true, whatsappOptOut: true,
          },
        },
        membership: { select: { plan: { select: { name: true } } } },
        recordedBy: { select: { id: true, name: true } },
      },
    });

    await audit(req, {
      action: "payment.create",
      entity: "payment",
      entityId: payment.id,
      entityLabel: `${member.memberNo} · ${member.name} · Rs. ${payment.amount}`,
      after: {
        memberId,
        amount: payment.amount.toNumber(),
        method: payment.method,
        channel: payment.channel,
        status: payment.status,
        type: payment.type,
        membershipId: payment.membershipId,
        paymentDate: payment.paymentDate,
      },
    });

    // Only for money actually taken. A `due` row records what is owed, and a
    // receipt for it would tell the member they had paid something they have
    // not.
    if (payment.status === "paid") {
      // Not awaited: the payment is recorded either way, and the desk should
      // not wait on Meta to hand back the change.
      void notifyPaymentReceipt(
        req.gymId,
        payment.member,
        payment.amount.toString(),
        // What they bought, in their own terms. The plan name when there is
        // one, and the payment's own kind when there is not — a supplement
        // sale or a registration fee has no membership to name.
        payment.membership?.plan.name ?? payment.type,
        // The payment's own date, not today's. A payment can be back-dated at
        // the desk — recording Friday's cash on Monday — and a receipt saying
        // Monday would contradict the register the member is shown.
        payment.paymentDate,
      );
    }

    res.status(201).json(withMoney(payment, "amount"));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
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
  const {
    amount,
    method,
    notes,
    status,
    type,
    membershipId,
    paymentDate,
    channel,
    reference,
  } = req.body;
  try {
    const existing = await prisma.payment.findFirst({
      where: { id, gymId: req.gymId },
      include: { member: { select: { name: true, memberNo: true } } },
    });
    if (!existing) {
      res.status(404).json({ error: "Payment not found" });
      return;
    }

    // Same rule as create: the membership has to be one this gym sold to the
    // member the payment already belongs to. The member itself is not editable,
    // so `existing.memberId` is the right thing to check against.
    if (membershipId) {
      const membership = await prisma.membership.findFirst({
        where: {
          id: membershipId,
          gymId: req.gymId,
          memberId: existing.memberId,
        },
        select: { id: true },
      });
      if (!membership) {
        res.status(404).json({ error: "Membership not found for this member" });
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
        ...(membershipId !== undefined && {
          membershipId: membershipId ?? null,
        }),
        ...(notes !== undefined && { notes }),
        ...(paymentDate && { paymentDate }),
        // Correcting an online payment to cash has to take the wallet's name
        // off it too, or the row keeps claiming money arrived by a route it
        // did not. Set explicitly rather than merged, so the correction is
        // complete.
        ...(method === "cash"
          ? { channel: null }
          : channel !== undefined && { channel: channel ?? null }),
        ...(reference !== undefined && { reference: reference ?? null }),
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
      "amount",
      "method",
      "channel",
      "reference",
      "status",
      "type",
      "membershipId",
      "notes",
      "paymentDate",
    ]);
    if (changed) {
      await audit(req, {
        action: "payment.update",
        entity: "payment",
        entityId: payment.id,
        entityLabel: `${existing.member.memberNo} · ${existing.member.name} · Rs. ${payment.amount}`,
        before: changed.before,
        after: changed.after,
      });
    }

    res.json(withMoney(payment, "amount"));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
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
      res.status(404).json({ error: "Payment not found" });
      return;
    }

    await prisma.payment.delete({ where: { id } });

    await audit(req, {
      action: "payment.delete",
      entity: "payment",
      entityId: existing.id,
      entityLabel: `${existing.member.memberNo} · ${existing.member.name} · Rs. ${existing.amount}`,
      before: {
        memberId: existing.memberId,
        amount: existing.amount.toNumber(),
        method: existing.method,
        status: existing.status,
        type: existing.type,
        membershipId: existing.membershipId,
        notes: existing.notes,
        paymentDate: existing.paymentDate,
      },
    });

    res.json({ message: "Deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};
