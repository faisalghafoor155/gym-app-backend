import type { Response } from 'express';
import prisma from '../db.js';
import { audit } from '../services/audit.js';
import {
  atMidnight, bookingErrorResponse, claimBooking, findBookableSchedule,
} from '../services/classBooking.js';
import type { AuthedRequest } from '../types.js';
import type {
  CreateClassBookingBody, UpdateClassBookingBody, ClassBookingQuery, IdParam,
} from '../schemas.js';

/**
 * Returns all bookings for class schedules.
 */
export const getAll = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, ClassBookingQuery>,
  res: Response,
): Promise<void> => {
  // The filters are validated by the route's schema now, which is also where
  // `date` is normalised to midnight — a booking is stored against a bare day,
  // so a filter carrying a time would otherwise match nothing and read as an
  // empty timetable rather than as a mismatched shape.
  const { memberId, scheduleId, date, status, page, limit } = req.query;

  try {
    const where = {
      gymId: req.gymId,
      ...(memberId && { memberId }),
      ...(scheduleId && { scheduleId }),
      ...(date && { bookingDate: date }),
      ...(status && { status }),
    };

    const [bookings, total] = await Promise.all([
      prisma.classBooking.findMany({
        where,
        include: {
          member: { select: { id: true, name: true, memberNo: true } },
          schedule: {
            include: {
              class: { select: { name: true } },
              trainer: { select: { name: true } },
            },
          },
        },
        orderBy: { bookingDate: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.classBooking.count({ where }),
    ]);

    const result = bookings.map(b => ({
      id: b.id,
      bookingDate: b.bookingDate,
      status: b.status,
      createdAt: b.createdAt,
      member: b.member,
      schedule: {
        id: b.schedule.id,
        className: b.schedule.class.name,
        trainerName: b.schedule.trainer?.name || null,
        startTime: b.schedule.startTime,
        endTime: b.schedule.endTime,
        dayOfWeek: b.schedule.dayOfWeek,
      },
    }));

    res.json({
      data: result,
      total,
      page,
      limit,
      hasMore: page * limit < total,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Books a member into a class schedule instance.
 */
export const create = async (
  req: AuthedRequest<unknown, unknown, CreateClassBookingBody>,
  res: Response,
): Promise<void> => {
  const { scheduleId, memberId, bookingDate } = req.body;
  const targetDate = atMidnight(bookingDate);

  try {
    // Staff name the member in the request, so it is checked against this gym
    // before anything else. The portal's version takes the member off the
    // session instead and never reads a body — see meController.bookClass.
    const member = await prisma.member.findFirst({
      where: { id: memberId, gymId: req.gymId },
    });
    if (!member) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    const found = await findBookableSchedule(req.gymId, scheduleId, targetDate);
    if (!found.ok) {
      res.status(found.status).json({ error: found.error });
      return;
    }

    const result = await claimBooking(
      req.gymId,
      scheduleId,
      memberId,
      targetDate,
      found.schedule.capacity,
    );

    await audit(req, {
      action: 'classBooking.create',
      entity: 'classBooking',
      entityId: result.id,
      entityLabel: `${member.name} in ${found.schedule.class.name} on ${targetDate.toLocaleDateString()}`,
      after: {
        scheduleId,
        memberId,
        bookingDate: targetDate,
        status: 'booked',
      },
    });

    res.status(201).json(result);
  } catch (err) {
    const refusal = bookingErrorResponse(err);
    if (refusal) {
      res.status(refusal.status).json(refusal.body);
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Updates slot booking status (attendance or cancel).
 */
export const update = async (
  req: AuthedRequest<IdParam, unknown, UpdateClassBookingBody>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    const booking = await prisma.classBooking.findFirst({
      where: { id, gymId: req.gymId },
      include: {
        member: { select: { name: true } },
        schedule: { include: { class: { select: { name: true } } } },
      },
    });
    if (!booking) {
      res.status(404).json({ error: 'Booking not found' });
      return;
    }

    const updated = await prisma.classBooking.update({
      where: { id },
      data: { status },
    });

    await audit(req, {
      action: 'classBooking.update',
      entity: 'classBooking',
      entityId: booking.id,
      entityLabel: `${booking.member.name} in ${booking.schedule.class.name}`,
      before: { status: booking.status },
      after: { status },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
