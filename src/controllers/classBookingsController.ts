import type { Response } from 'express';
import prisma from '../db.js';
import { audit } from '../services/audit.js';
import type { AuthedRequest } from '../types.js';
import type { CreateClassBookingBody, UpdateClassBookingBody, IdParam } from '../schemas.js';

/**
 * Returns all bookings for class schedules.
 */
export const getAll = async (
  req: AuthedRequest,
  res: Response,
): Promise<void> => {
  const { memberId, scheduleId, date } = req.query;
  const memberIdStr = typeof memberId === 'string' ? memberId : undefined;
  const scheduleIdStr = typeof scheduleId === 'string' ? scheduleId : undefined;
  const parsedDate = date ? new Date(String(date)) : undefined;

  try {
    const bookings = await prisma.classBooking.findMany({
      where: {
        gymId: req.gymId,
        ...(memberIdStr && { memberId: memberIdStr }),
        ...(scheduleIdStr && { scheduleId: scheduleIdStr }),
        ...(parsedDate && { bookingDate: parsedDate }),
      },
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
    });

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

    res.json(result);
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
  const targetDate = new Date(bookingDate);
  targetDate.setHours(0, 0, 0, 0);

  try {
    const member = await prisma.member.findFirst({
      where: { id: memberId, gymId: req.gymId },
    });
    if (!member) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    const schedule = await prisma.classSchedule.findFirst({
      where: { id: scheduleId, gymId: req.gymId, isActive: true },
      include: { class: { select: { name: true } } },
    });
    if (!schedule) {
      res.status(404).json({ error: 'Schedule slot not found or inactive' });
      return;
    }

    // Verify booking date day matches dayOfWeek
    if (targetDate.getDay() !== schedule.dayOfWeek) {
      res.status(400).json({ error: 'Booking date does not match the day of the week for this class schedule' });
      return;
    }

    // Perform transaction to ensure capacity is not exceeded at booking time
    const result = await prisma.$transaction(async (tx) => {
      // Check existing booking
      const existing = await tx.classBooking.findFirst({
        where: {
          memberId,
          scheduleId,
          bookingDate: targetDate,
        },
      });

      if (existing) {
        if (existing.status === 'cancelled') {
          // Reactivate cancelled booking
          return tx.classBooking.update({
            where: { id: existing.id },
            data: { status: 'booked' },
          });
        }
        throw new Error('already_booked');
      }

      // Check current capacity
      const bookingsCount = await tx.classBooking.count({
        where: {
          scheduleId,
          bookingDate: targetDate,
          status: { not: 'cancelled' },
        },
      });

      if (bookingsCount >= schedule.capacity) {
        throw new Error('capacity_exceeded');
      }

      return tx.classBooking.create({
        data: {
          gymId: req.gymId,
          scheduleId,
          memberId,
          bookingDate: targetDate,
          status: 'booked',
        },
      });
    });

    await audit(req, {
      action: 'classBooking.create',
      entity: 'classBooking',
      entityId: result.id,
      entityLabel: `${member.name} in ${schedule.class.name} on ${targetDate.toLocaleDateString()}`,
      after: {
        scheduleId,
        memberId,
        bookingDate: targetDate,
        status: 'booked',
      },
    });

    res.status(201).json(result);
  } catch (err: any) {
    if (err.message === 'capacity_exceeded') {
      res.status(400).json({ error: 'This class session is fully booked (capacity reached)' });
      return;
    }
    if (err.message === 'already_booked') {
      res.status(400).json({ error: 'Member is already booked into this class session' });
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
