/** @format */

import type { Prisma } from '@prisma/client';
import prisma from '../db.js';

/**
 * Booking somebody into a class session.
 *
 * Extracted from the controller because there are now two ways in — a staff
 * member booking anybody, and a member booking themselves from the portal —
 * and the hard part of this is the concurrency, which neither path should own
 * a copy of. A second implementation would be a second chance to get the
 * isolation level wrong, and the failure would be a class quietly running over
 * capacity rather than an error anybody sees.
 *
 * Who is allowed to book whom is *not* decided here. That is the caller's
 * question and the two answers differ: staff name the member in the request,
 * while the portal takes the member off the session and never reads the body.
 */

/** Why a booking could not be made. Thrown rather than returned so a caller
 *  cannot forget to check, and mapped to a status by `bookingErrorResponse`. */
export class BookingError extends Error {
  constructor(readonly reason: 'capacity_exceeded' | 'already_booked') {
    super(reason);
    this.name = 'BookingError';
  }
}

/** Postgres and Prisma both have a word for "you raced somebody and lost". */
const isRetryable = (e: unknown): boolean => {
  const code = (e as { code?: string }).code;
  return code === 'P2034' || code === '40001' || code === 'P2002';
};

/**
 * Claims a place, or throws.
 *
 * Capacity is counted and then written, which is only safe if no other booking
 * can slip in between the two. Read Committed does not give that: two people
 * booking the last place both count nine, both find room and both insert, and
 * the class runs one over. Serializable is what makes the count a promise —
 * Postgres aborts the loser rather than letting it through.
 *
 * An abort is not a refusal, though. It means "your view of the class was
 * stale, look again", and answering "full" on the strength of one would turn
 * somebody away from a class with places left. So it is retried, and only a
 * count taken cleanly can refuse. A few goes settles it: contention is between
 * the handful of people booking one class at one moment.
 */
export const claimBooking = async (
  gymId: string,
  scheduleId: string,
  memberId: string,
  bookingDate: Date,
  capacity: number,
) => {
  const attempt = () =>
    prisma.$transaction(
      async (tx) => {
        const existing = await tx.classBooking.findFirst({
          where: { memberId, scheduleId, bookingDate },
        });

        // Somebody already booked into this session cannot book again,
        // whatever the room looks like.
        if (existing && existing.status !== 'cancelled') {
          throw new BookingError('already_booked');
        }

        // Counted before both paths, not just the insert. Coming back from a
        // cancellation is asking for a place like anybody else — the place
        // they gave up may well have been taken while they were gone.
        const taken = await tx.classBooking.count({
          where: {
            scheduleId,
            bookingDate,
            status: { not: 'cancelled' },
          },
        });

        if (taken >= capacity) throw new BookingError('capacity_exceeded');

        if (existing) {
          return tx.classBooking.update({
            where: { id: existing.id },
            data: { status: 'booked' },
          });
        }

        return tx.classBooking.create({
          data: {
            gymId,
            scheduleId,
            memberId,
            bookingDate,
            status: 'booked',
          },
        });
      },
      { isolationLevel: 'Serializable' },
    );

  for (let tries = 0; ; tries++) {
    try {
      return await attempt();
    } catch (err) {
      // A BookingError is the answer, not a collision — retrying it would only
      // reach the same conclusion four more times.
      if (err instanceof BookingError) throw err;
      if (tries >= 4 || !isRetryable(err)) throw err;
    }
  }
};

/**
 * Turns a failed booking into the reply.
 *
 * A lost race reads as a full class rather than as a fault: the other request
 * took the place, so the caller is told the same thing they would have been
 * told a moment later anyway. Returns null for anything else, which the caller
 * should treat as a real error.
 */
export const bookingErrorResponse = (
  err: unknown,
): { status: number; body: { error: string } } | null => {
  if (err instanceof BookingError) {
    return err.reason === 'capacity_exceeded'
      ? {
          status: 400,
          body: { error: 'This class session is fully booked (capacity reached)' },
        }
      : {
          status: 400,
          body: { error: 'Already booked into this class session' },
        };
  }
  if (isRetryable(err)) {
    return {
      status: 400,
      body: { error: 'This class session is fully booked (capacity reached)' },
    };
  }
  return null;
};

/**
 * The session being booked, checked against the gym and the calendar.
 *
 * Returns a string when it cannot be booked, so both callers refuse for the
 * same reasons in the same words rather than each inventing its own.
 */
export const findBookableSchedule = async (
  gymId: string,
  scheduleId: string,
  bookingDate: Date,
): Promise<
  | { ok: true; schedule: BookableSchedule }
  | { ok: false; status: 404 | 400; error: string }
> => {
  const schedule = await prisma.classSchedule.findFirst({
    where: { id: scheduleId, gymId, isActive: true },
    include: { class: { select: { name: true } } },
  });
  if (!schedule) {
    return { ok: false, status: 404, error: 'Schedule slot not found or inactive' };
  }

  // A slot recurs weekly on one day, so a date that falls on another day is
  // asking for a session that does not exist.
  if (bookingDate.getDay() !== schedule.dayOfWeek) {
    return {
      ok: false,
      status: 400,
      error:
        'Booking date does not match the day of the week for this class schedule',
    };
  }

  return { ok: true, schedule };
};

/** What a caller needs off the slot to book into it and to name it in a log. */
export type BookableSchedule = Prisma.ClassScheduleGetPayload<{
  include: { class: { select: { name: true } } };
}>;

/** Bookings are stored against a bare day, so every date is flattened to
 *  midnight before it is compared or written. */
export const atMidnight = (date: Date): Date => {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
};
