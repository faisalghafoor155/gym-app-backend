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

    /*
     * Capacity is counted and then written, which is only safe if no other
     * booking can slip in between the two. Read Committed does not give that:
     * two receptionists booking the last place both count nine, both find room
     * and both insert, and the class runs one over. Serializable is what makes
     * the count a promise — Postgres aborts the loser rather than letting it
     * through.
     *
     * An abort is not a refusal, though. It means "your view of the class was
     * stale, look again", and a booking that answered "full" on the strength
     * of one would turn somebody away from a class with places left. So it is
     * retried, and only a count taken cleanly can refuse.
     */
    const attempt = () => prisma.$transaction(async (tx) => {
      const existing = await tx.classBooking.findFirst({
        where: {
          memberId,
          scheduleId,
          bookingDate: targetDate,
        },
      });

      // Somebody already booked into this session cannot book again, whatever
      // the room looks like.
      if (existing && existing.status !== 'cancelled') {
        throw new Error('already_booked');
      }

      // Counted before both paths, not just the insert. Coming back from a
      // cancellation is asking for a place like anybody else — the place they
      // gave up may well have been taken while they were gone.
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

      if (existing) {
        return tx.classBooking.update({
          where: { id: existing.id },
          data: { status: 'booked' },
        });
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
    }, { isolationLevel: 'Serializable' });

    /** Retried a few times: contention is between the handful of people
     *  booking one class at one moment, so a couple of goes settles it. */
    const isRetryable = (e: { code?: string }): boolean =>
      e.code === 'P2034' || e.code === '40001' || e.code === 'P2002';

    let result;
    for (let tries = 0; ; tries++) {
      try {
        result = await attempt();
        break;
      } catch (err) {
        if (tries >= 4 || !isRetryable(err as { code?: string })) throw err;
      }
    }

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
    // Two bookings raced for the same place and Postgres aborted this one
    // (40001), or both reached the unique index at once (P2002). Either way
    // the other request took the place, so this reads as a full class rather
    // than as a fault — the caller is told the same thing they would have been
    // told a moment later anyway.
    if (err.code === 'P2034' || err.code === '40001' || err.code === 'P2002') {
      res.status(400).json({ error: 'This class session is fully booked (capacity reached)' });
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
