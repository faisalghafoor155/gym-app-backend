/** @format */

import type { Response } from "express";
import prisma from "../db.js";
import {
  currentMembershipWhere,
  effectiveMemberStatus,
  toView,
  withPlan,
} from "../services/membership.js";
import { sum, withMoney } from "../services/money.js";
import { getPhotoUrl } from "../services/s3.js";
import { audit } from "../services/audit.js";
import {
  atMidnight,
  bookingErrorResponse,
  claimBooking,
  findBookableSchedule,
} from "../services/classBooking.js";
import type { AuthedRequest } from "../types.js";
import type {
  BookMyClassBody,
  IdParam,
  MyHistoryQuery,
  MyScheduleQuery,
} from "../schemas.js";

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
        photoKey: true,
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

  const { memberships, photoKey, ...profile } = member;

  return {
    member: {
      ...profile,
      // The bucket is private, so the member's own face is signed for this
      // reply and expires with it. `photoKey` stays server-side.
      photo: profile.photo ?? (await getPhotoUrl(photoKey)),
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

/**
 * The member behind the session, or null.
 *
 * Every endpoint below is scoped by this rather than by an id in the URL, so
 * "can this member see this?" is never a question any of them has to ask —
 * there is nothing to tamper with. A staff or owner account has no `memberId`,
 * which is what the 404 says: not "forbidden", but "this account is not a
 * member", which is the true and more useful answer.
 */
const requireMemberId = (req: AuthedRequest, res: Response): string | null => {
  if (!req.memberId) {
    res
      .status(404)
      .json({ error: "This account is not linked to a member record" });
    return null;
  }
  return req.memberId;
};

/** Every membership this member has ever held, newest first. */
export const getMyMemberships = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, MyHistoryQuery>,
  res: Response,
): Promise<void> => {
  const memberId = requireMemberId(req, res);
  if (!memberId) return;

  const { page, limit } = req.query;
  try {
    const where = { memberId };
    const [memberships, total] = await Promise.all([
      prisma.membership.findMany({
        where,
        include: withPlan,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.membership.count({ where }),
    ]);

    res.json({
      data: memberships.map((m) => toView(m)),
      total,
      page,
      limit,
      hasMore: page * limit < total,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * What this member has bought over the counter.
 *
 * Reads from `SupplementSale` rather than from the payments list, which
 * already carries the money: this answers "what did I buy", naming the product
 * and the quantity, which a payment row of type `supplement` cannot.
 */
export const getMyPurchases = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, MyHistoryQuery>,
  res: Response,
): Promise<void> => {
  const memberId = requireMemberId(req, res);
  if (!memberId) return;

  const { page, limit } = req.query;
  try {
    const where = { memberId };
    const [sales, total] = await Promise.all([
      prisma.supplementSale.findMany({
        where,
        select: {
          id: true,
          quantity: true,
          unitPrice: true,
          total: true,
          soldAt: true,
          supplement: { select: { name: true, category: true } },
        },
        orderBy: { soldAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.supplementSale.count({ where }),
    ]);

    res.json({
      data: sales.map(({ supplement, ...sale }) => ({
        ...withMoney(withMoney(sale, "unitPrice"), "total"),
        supplementName: supplement.name,
        category: supplement.category,
      })),
      total,
      page,
      limit,
      hasMore: page * limit < total,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

/** This member's own class bookings, newest first. */
export const getMyBookings = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, MyHistoryQuery>,
  res: Response,
): Promise<void> => {
  const memberId = requireMemberId(req, res);
  if (!memberId) return;

  const { page, limit } = req.query;
  try {
    const where = { memberId };
    const [bookings, total] = await Promise.all([
      prisma.classBooking.findMany({
        where,
        select: {
          id: true,
          bookingDate: true,
          status: true,
          schedule: {
            select: {
              id: true,
              startTime: true,
              endTime: true,
              dayOfWeek: true,
              class: { select: { name: true } },
              trainer: { select: { name: true } },
            },
          },
        },
        orderBy: { bookingDate: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.classBooking.count({ where }),
    ]);

    res.json({
      data: bookings.map((b) => ({
        id: b.id,
        bookingDate: b.bookingDate,
        status: b.status,
        scheduleId: b.schedule.id,
        className: b.schedule.class.name,
        trainerName: b.schedule.trainer?.name ?? null,
        startTime: b.schedule.startTime,
        endTime: b.schedule.endTime,
        dayOfWeek: b.schedule.dayOfWeek,
      })),
      total,
      page,
      limit,
      hasMore: page * limit < total,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * The timetable for one day, with this member's own bookings marked.
 *
 * `booked` is per-member, which is why this exists rather than the member
 * reusing the staff `/classes/schedules`: that one answers "how full is this
 * class", and a member needs "am I in it" as well, without being handed
 * everybody else's bookings to work it out from.
 */
export const getMySchedule = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, MyScheduleQuery>,
  res: Response,
): Promise<void> => {
  const memberId = requireMemberId(req, res);
  if (!memberId) return;

  const day = atMidnight(req.query.date ?? new Date());
  try {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: { gymId: true },
    });
    if (!member) {
      res.status(404).json({ error: "Member record not found" });
      return;
    }

    const schedules = await prisma.classSchedule.findMany({
      where: { gymId: member.gymId, isActive: true, dayOfWeek: day.getDay() },
      select: {
        id: true,
        startTime: true,
        endTime: true,
        dayOfWeek: true,
        capacity: true,
        class: { select: { name: true, description: true } },
        trainer: { select: { name: true } },
        bookings: {
          where: { bookingDate: day, status: { not: "cancelled" } },
          select: { memberId: true },
        },
      },
      orderBy: { startTime: "asc" },
    });

    res.json(
      schedules.map((s) => ({
        id: s.id,
        className: s.class.name,
        classDescription: s.class.description,
        trainerName: s.trainer?.name ?? null,
        startTime: s.startTime,
        endTime: s.endTime,
        dayOfWeek: s.dayOfWeek,
        capacity: s.capacity,
        bookingsCount: s.bookings.length,
        remainingCapacity: Math.max(0, s.capacity - s.bookings.length),
        // Which is the whole point of this endpoint. Only the member's own
        // presence travels; the other ids are counted and dropped.
        booked: s.bookings.some((b) => b.memberId === memberId),
      })),
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * Books this member into a class.
 *
 * The member comes off the session, never the body — see `bookMyClassSchema`,
 * which has no `memberId` field for a caller to put somebody else's id in.
 *
 * An active membership is required, unlike check-in, which lets anybody
 * through. The two are different acts: waving somebody in costs the gym
 * nothing and is the moment to sell them a renewal, while holding a place in a
 * class takes it from a paying member. A lapsed member is told to renew rather
 * than refused flatly, since renewing is exactly what they should do next.
 */
export const bookMyClass = async (
  req: AuthedRequest<Record<string, string>, unknown, BookMyClassBody>,
  res: Response,
): Promise<void> => {
  const memberId = requireMemberId(req, res);
  if (!memberId) return;

  const { scheduleId, bookingDate } = req.body;
  const day = atMidnight(bookingDate);

  try {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: {
        gymId: true,
        name: true,
        status: true,
        memberships: {
          where: currentMembershipWhere,
          orderBy: { createdAt: "desc" },
          take: 1,
          include: withPlan,
        },
      },
    });
    if (!member) {
      res.status(404).json({ error: "Member record not found" });
      return;
    }

    // The same rule the roster uses to decide who is still on the books, so a
    // member the gym considers lapsed cannot hold a place through the portal.
    const current = member.memberships[0] ?? null;
    if (effectiveMemberStatus(member.status, current) !== "active") {
      res.status(403).json({
        error: "Your membership is not active. Renew it to book classes.",
        reason: "membership_inactive",
      });
      return;
    }

    const found = await findBookableSchedule(member.gymId, scheduleId, day);
    if (!found.ok) {
      res.status(found.status).json({ error: found.error });
      return;
    }

    const booking = await claimBooking(
      member.gymId,
      scheduleId,
      memberId,
      day,
      found.schedule.capacity,
    );

    // Audited like the staff booking, and named as the member's own doing: the
    // trail has to be able to say a place was taken from the portal rather
    // than by somebody at the desk.
    await audit(req, {
      action: "classBooking.selfCreate",
      entity: "classBooking",
      entityId: booking.id,
      entityLabel: `${member.name} in ${found.schedule.class.name} on ${day.toLocaleDateString()}`,
      after: { scheduleId, bookingDate: day, status: "booked" },
    });

    res.status(201).json(booking);
  } catch (err) {
    const refusal = bookingErrorResponse(err);
    if (refusal) {
      res.status(refusal.status).json(refusal.body);
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * Gives up a place this member holds.
 *
 * Scoped by the session's member as well as by the id, so a member cannot
 * cancel somebody else's booking by guessing at one. Cancelling frees the
 * place for the next person, which is the reason members are trusted with this
 * at all — a no-show holds a place nobody can use.
 */
export const cancelMyBooking = async (
  req: AuthedRequest<IdParam>,
  res: Response,
): Promise<void> => {
  const memberId = requireMemberId(req, res);
  if (!memberId) return;

  const { id } = req.params;
  try {
    const booking = await prisma.classBooking.findFirst({
      where: { id, memberId },
      include: {
        schedule: { include: { class: { select: { name: true } } } },
      },
    });
    // Not "forbidden": a booking belonging to somebody else and a booking that
    // does not exist are the same fact from here, and saying which would
    // confirm the id belongs to a real booking.
    if (!booking) {
      res.status(404).json({ error: "Booking not found" });
      return;
    }

    if (booking.status === "cancelled") {
      res.json(booking);
      return;
    }

    // Attendance is a record of what happened. Cancelling after the fact would
    // rewrite it, and the place is long gone either way.
    if (booking.status === "attended") {
      res.status(400).json({ error: "This class has already been attended" });
      return;
    }

    const cancelled = await prisma.classBooking.update({
      where: { id },
      data: { status: "cancelled" },
    });

    await audit(req, {
      action: "classBooking.selfCancel",
      entity: "classBooking",
      entityId: id,
      entityLabel: `${booking.schedule.class.name} on ${booking.bookingDate.toLocaleDateString()}`,
      before: { status: booking.status },
      after: { status: "cancelled" },
    });

    res.json(cancelled);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};
