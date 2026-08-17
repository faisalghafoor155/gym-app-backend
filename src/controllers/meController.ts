/** @format */

import type { Response } from "express";
import prisma from "../db.js";
import { toView, withPlan } from "../services/membership.js";
import { sum, withMoney } from "../services/money.js";
import type { AuthedRequest } from "../types.js";

const buildMyProfileResponse = async (memberId: string) => {
  const [member, plan, attendance, payments] = await Promise.all([
    prisma.member.findUnique({
      where: { id: memberId },
      select: {
        id: true,
        memberNo: true,
        name: true,
        email: true,
        phone: true,
        photo: true,
        gender: true,
        dateOfBirth: true,
        address: true,
        emergencyContact: true,
        memberships: {
          where: { status: { notIn: ["superseded", "cancelled"] } },
          orderBy: { createdAt: "desc" },
          take: 1,
          include: withPlan,
        },
      },
    }),
    prisma.memberPlan.findFirst({
      where: { memberId },
      include: { workoutPlan: true, dietPlan: true },
      orderBy: { assignedAt: "desc" },
    }),
    prisma.attendance.findMany({
      where: { memberId },
      orderBy: { checkedInAt: "desc" },
      take: 30,
    }),
    prisma.payment.findMany({
      where: { memberId },
      orderBy: { paymentDate: "desc" },
      take: 20,
    }),
  ]);

  if (!member) {
    return null;
  }

  const { memberships, ...profile } = member;

  return {
    member: {
      ...profile,
      currentMembership: memberships[0] ? toView(memberships[0]) : null,
    },
    plan,
    attendance,
    payments: payments.map((p) => withMoney(p, "amount")),
    dueTotal: sum(
      payments.filter((p) => p.status === "due").map((p) => p.amount),
    ),
  };
};

/**
 * Everything a signed-in member can see about themselves. Scoped by the
 * memberId on the session, so a member can only ever read their own record —
 * there is no id in the URL to tamper with.
 */
export const getMyProfile = async (
  req: AuthedRequest,
  res: Response,
): Promise<void> => {
  if (!req.memberId) {
    res
      .status(404)
      .json({ error: "This account is not linked to a member record" });
    return;
  }

  try {
    const result = await buildMyProfileResponse(req.memberId);
    if (!result) {
      res.status(404).json({ error: "Member record not found" });
      return;
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

export const updateMyProfile = async (
  req: AuthedRequest<
    Record<string, string>,
    unknown,
    {
      phone?: string | null;
      email?: string | null;
      address?: string | null;
      emergencyContact?: string | null;
    }
  >,
  res: Response,
): Promise<void> => {
  if (!req.memberId) {
    res
      .status(404)
      .json({ error: "This account is not linked to a member record" });
    return;
  }

  try {
    const { phone, email, address, emergencyContact } = req.body;
    const data: {
      phone?: string | null;
      email?: string | null;
      address?: string | null;
      emergencyContact?: string | null;
    } = {};

    if (phone !== undefined)
      data.phone = phone ? String(phone).trim() || null : null;
    if (email !== undefined)
      data.email = email ? String(email).trim().toLowerCase() || null : null;
    if (address !== undefined)
      data.address = address ? String(address).trim() || null : null;
    if (emergencyContact !== undefined)
      data.emergencyContact = emergencyContact
        ? String(emergencyContact).trim() || null
        : null;

    if (Object.keys(data).length === 0) {
      res.status(400).json({ error: "No valid fields were provided" });
      return;
    }

    await prisma.member.update({
      where: { id: req.memberId },
      data,
    });

    const result = await buildMyProfileResponse(req.memberId);
    if (!result) {
      res.status(404).json({ error: "Member record not found" });
      return;
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};
