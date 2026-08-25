import { beforeEach, describe, expect, it } from 'vitest';

import prisma from '../../src/db.js';
import { addMember, addUser, api, makeGym, resetDb } from '../helpers.js';

/**
 * Booking a place in a class.
 *
 * A class has a fixed number of places, so this is the same problem as the
 * last tub of protein on the shelf: two people asking at once must not both
 * get it. The difference is that a class also has to be able to give a place
 * back — somebody who cancels frees theirs — and that is where the counting
 * gets interesting.
 */

beforeEach(resetDb);

/** The next date falling on a given weekday, which is what a booking needs. */
const nextDayOfWeek = (dayOfWeek: number): Date => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((dayOfWeek - d.getDay() + 7) % 7 || 7));
  return d;
};

const DAY = 1; // Monday

/** A gym with one class, one schedule of the given capacity, and members. */
const aClassWith = async (capacity: number, memberCount = 0) => {
  const owner = await makeGym();

  const cls = await api().post('/api/classes').set('Cookie', owner.cookie)
    .send({ name: 'Spin' });
  const classId = cls.body.id ?? cls.body.data?.id;

  const sched = await api().post('/api/classes/schedules').set('Cookie', owner.cookie)
    .send({ classId, dayOfWeek: DAY, startTime: '09:00', endTime: '10:00', capacity });
  const scheduleId = sched.body.id ?? sched.body.data?.id;

  const members = [];
  for (let i = 0; i < memberCount; i++) {
    members.push(await addMember(owner.gymId, {
      name: `Member ${i}`, phone: `0300000${String(i).padStart(4, '0')}`,
    }));
  }

  return { owner, classId, scheduleId, members, date: nextDayOfWeek(DAY) };
};

const book = (cookie: string, scheduleId: string, memberId: string, date: Date) =>
  api().post('/api/class-bookings').set('Cookie', cookie)
    .send({ scheduleId, memberId, bookingDate: date.toISOString() });

describe('booking a place', () => {
  it('books a member in', async () => {
    const { owner, scheduleId, members, date } = await aClassWith(10, 1);

    const res = await book(owner.cookie, scheduleId, members[0].id, date);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('booked');
    expect(await prisma.classBooking.count({ where: { scheduleId } })).toBe(1);
  });

  it('refuses a date that is not the day the class runs', async () => {
    const { owner, scheduleId, members } = await aClassWith(10, 1);
    // The schedule is Monday; this is the Tuesday after it.
    const wrongDay = nextDayOfWeek(DAY + 1);

    const res = await book(owner.cookie, scheduleId, members[0].id, wrongDay);

    expect(res.status).toBe(400);
    expect(await prisma.classBooking.count()).toBe(0);
  });

  it('refuses the same member twice for the same session', async () => {
    const { owner, scheduleId, members, date } = await aClassWith(10, 1);

    const first = await book(owner.cookie, scheduleId, members[0].id, date);
    const second = await book(owner.cookie, scheduleId, members[0].id, date);

    expect(first.status).toBe(201);
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/already booked/i);
    expect(await prisma.classBooking.count({ where: { scheduleId } })).toBe(1);
  });

  it('lets the same member book a different week of the same class', async () => {
    const { owner, scheduleId, members, date } = await aClassWith(10, 1);
    const nextWeek = new Date(date);
    nextWeek.setDate(nextWeek.getDate() + 7);

    const first = await book(owner.cookie, scheduleId, members[0].id, date);
    const second = await book(owner.cookie, scheduleId, members[0].id, nextWeek);

    // A weekly class is a different session each week; booking both is normal.
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });
});

describe('capacity', () => {
  it('fills every place and then refuses', async () => {
    const { owner, scheduleId, members, date } = await aClassWith(3, 4);

    for (let i = 0; i < 3; i++) {
      expect((await book(owner.cookie, scheduleId, members[i].id, date)).status).toBe(201);
    }
    const overflow = await book(owner.cookie, scheduleId, members[3].id, date);

    expect(overflow.status).toBe(400);
    expect(overflow.body.error).toMatch(/full|capacity/i);
    expect(await prisma.classBooking.count({
      where: { scheduleId, status: { not: 'cancelled' } },
    })).toBe(3);
  });

  it('allows the booking that takes the last place', async () => {
    const { owner, scheduleId, members, date } = await aClassWith(2, 2);

    await book(owner.cookie, scheduleId, members[0].id, date);
    const last = await book(owner.cookie, scheduleId, members[1].id, date);

    expect(last.status).toBe(201);
  });

  it('never hands the last place to two people at once', async () => {
    const { owner, scheduleId, members, date } = await aClassWith(1, 2);

    const [a, b] = await Promise.all([
      book(owner.cookie, scheduleId, members[0].id, date),
      book(owner.cookie, scheduleId, members[1].id, date),
    ]);

    // Two receptionists booking the same last place is the whole reason the
    // count and the insert sit in one transaction.
    expect([a.status, b.status].sort()).toEqual([201, 400]);
    expect(await prisma.classBooking.count({
      where: { scheduleId, status: { not: 'cancelled' } },
    })).toBe(1);
  });

  it('never oversells a class when a whole queue arrives together', async () => {
    const { owner, scheduleId, members, date } = await aClassWith(3, 8);

    await Promise.all(
      members.map(m => book(owner.cookie, scheduleId, m.id, date)),
    );

    // The count that matters: eight people asked for three places.
    expect(await prisma.classBooking.count({
      where: { scheduleId, status: { not: 'cancelled' } },
    })).toBe(3);
  });
});

describe('cancelling, and the place it frees', () => {
  it('frees the place for somebody else', async () => {
    const { owner, scheduleId, members, date } = await aClassWith(1, 2);
    const booked = await book(owner.cookie, scheduleId, members[0].id, date);

    // Full, so the second member is turned away.
    expect((await book(owner.cookie, scheduleId, members[1].id, date)).status).toBe(400);

    await api().put(`/api/class-bookings/${booked.body.id}`)
      .set('Cookie', owner.cookie).send({ status: 'cancelled' });

    // A cancelled booking is not holding a place any more.
    const after = await book(owner.cookie, scheduleId, members[1].id, date);
    expect(after.status).toBe(201);
  });

  it('lets somebody who cancelled book back in while there is room', async () => {
    const { owner, scheduleId, members, date } = await aClassWith(2, 1);
    const booked = await book(owner.cookie, scheduleId, members[0].id, date);
    await api().put(`/api/class-bookings/${booked.body.id}`)
      .set('Cookie', owner.cookie).send({ status: 'cancelled' });

    const again = await book(owner.cookie, scheduleId, members[0].id, date);

    expect(again.status).toBe(201);
    expect(again.body.status).toBe('booked');
    // Reactivated rather than duplicated: the unique constraint on
    // (member, schedule, date) means there can only ever be the one row.
    expect(await prisma.classBooking.count({
      where: { scheduleId, memberId: members[0].id },
    })).toBe(1);
  });

  it('does not let a cancelled member back into a class that filled up', async () => {
    const { owner, scheduleId, members, date } = await aClassWith(1, 2);
    const booked = await book(owner.cookie, scheduleId, members[0].id, date);
    await api().put(`/api/class-bookings/${booked.body.id}`)
      .set('Cookie', owner.cookie).send({ status: 'cancelled' });

    // Somebody else takes the freed place.
    expect((await book(owner.cookie, scheduleId, members[1].id, date)).status).toBe(201);

    // Rejoining now would put two people in a class of one.
    const rejoin = await book(owner.cookie, scheduleId, members[0].id, date);

    expect(rejoin.status).toBe(400);
    expect(await prisma.classBooking.count({
      where: { scheduleId, status: { not: 'cancelled' } },
    })).toBe(1);
  });

  it('marks attendance without freeing the place', async () => {
    const { owner, scheduleId, members, date } = await aClassWith(1, 2);
    const booked = await book(owner.cookie, scheduleId, members[0].id, date);

    await api().put(`/api/class-bookings/${booked.body.id}`)
      .set('Cookie', owner.cookie).send({ status: 'attended' });

    // Somebody who turned up is still occupying their place.
    const other = await book(owner.cookie, scheduleId, members[1].id, date);
    expect(other.status).toBe(400);
  });
});

describe('bookings and other gyms', () => {
  it('will not book another gym\'s schedule', async () => {
    const { scheduleId, date } = await aClassWith(10, 0);
    const other = await makeGym({ gymName: 'Rival Gym' });
    const theirMember = await addMember(other.gymId);

    const res = await book(other.cookie, scheduleId, theirMember.id, date);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.classBooking.count()).toBe(0);
  });

  it('will not book another gym\'s member into its own class', async () => {
    const { owner, scheduleId, date } = await aClassWith(10, 0);
    const other = await makeGym({ gymName: 'Rival Gym' });
    const theirMember = await addMember(other.gymId);

    const res = await book(owner.cookie, scheduleId, theirMember.id, date);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.classBooking.count()).toBe(0);
  });

  it('lists only its own bookings', async () => {
    const { owner, scheduleId, members, date } = await aClassWith(10, 1);
    await book(owner.cookie, scheduleId, members[0].id, date);
    const other = await makeGym({ gymName: 'Rival Gym' });

    const mine = await api().get('/api/class-bookings').set('Cookie', owner.cookie);
    const theirs = await api().get('/api/class-bookings').set('Cookie', other.cookie);

    expect(((mine.body.data ?? mine.body) as unknown[])).toHaveLength(1);
    expect(((theirs.body.data ?? theirs.body) as unknown[])).toHaveLength(0);
  });

  it('will not change another gym\'s booking', async () => {
    const { owner, scheduleId, members, date } = await aClassWith(10, 1);
    const booked = await book(owner.cookie, scheduleId, members[0].id, date);
    const other = await makeGym({ gymName: 'Rival Gym' });

    const res = await api().put(`/api/class-bookings/${booked.body.id}`)
      .set('Cookie', other.cookie).send({ status: 'cancelled' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    const after = await prisma.classBooking.findUniqueOrThrow({ where: { id: booked.body.id } });
    expect(after.status).toBe('booked');
  });

  it('refuses a member with no session at all', async () => {
    const { scheduleId, members, date } = await aClassWith(10, 1);

    const res = await api().post('/api/class-bookings')
      .send({ scheduleId, memberId: members[0].id, bookingDate: date.toISOString() });

    expect(res.status).toBe(401);
  });

  it('refuses staff who may not manage classes', async () => {
    const { owner, scheduleId, members, date } = await aClassWith(10, 1);
    const staff = await addUser(owner.gymId, { role: 'staff' });

    const res = await book(staff.cookie, scheduleId, members[0].id, date);

    // Booking sits behind `canManageClasses` rather than being open to the
    // whole front desk — a timetable is the gym's to arrange.
    expect(res.status).toBe(403);
    expect(await prisma.classBooking.count()).toBe(0);
  });
});

describe('finding bookings again', () => {
  /** Two members, two sessions a week apart, so every filter has something to
   *  exclude as well as something to find. */
  const aWeekOfBookings = async () => {
    const ctx = await aClassWith(10, 2);
    const nextWeek = new Date(ctx.date);
    nextWeek.setDate(nextWeek.getDate() + 7);

    await book(ctx.owner.cookie, ctx.scheduleId, ctx.members[0].id, ctx.date);
    await book(ctx.owner.cookie, ctx.scheduleId, ctx.members[1].id, ctx.date);
    await book(ctx.owner.cookie, ctx.scheduleId, ctx.members[0].id, nextWeek);

    return { ...ctx, nextWeek };
  };

  const rows = (body: unknown): { member: { id: string } }[] =>
    (body as { data?: unknown[] }).data as never ?? body as never;

  it('lists them all when nothing is asked for', async () => {
    const { owner } = await aWeekOfBookings();

    const res = await api().get('/api/class-bookings').set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    expect(rows(res.body)).toHaveLength(3);
  });

  it('narrows to one member', async () => {
    const { owner, members } = await aWeekOfBookings();

    const res = await api().get('/api/class-bookings')
      .query({ memberId: members[0].id }).set('Cookie', owner.cookie);

    expect(rows(res.body)).toHaveLength(2);
    expect(rows(res.body).every(b => b.member.id === members[0].id)).toBe(true);
  });

  it('narrows to one session of the week', async () => {
    const { owner, date } = await aWeekOfBookings();

    const res = await api().get('/api/class-bookings')
      .query({ date: date.toISOString() }).set('Cookie', owner.cookie);

    // Two people booked that day; the third booking is the week after.
    expect(rows(res.body)).toHaveLength(2);
  });

  it('finds the day whether or not a time was sent with it', async () => {
    const { owner, date } = await aWeekOfBookings();
    const withTime = new Date(date);
    withTime.setHours(18, 30, 0, 0);

    const plain = await api().get('/api/class-bookings')
      .query({ date: date.toISOString() }).set('Cookie', owner.cookie);
    const timed = await api().get('/api/class-bookings')
      .query({ date: withTime.toISOString() }).set('Cookie', owner.cookie);

    // Bookings are stored at midnight, so a filter carrying an evening time
    // used to match nothing at all.
    expect(rows(timed.body)).toHaveLength(rows(plain.body).length);
    expect(rows(timed.body)).toHaveLength(2);
  });

  it('narrows to one schedule', async () => {
    const { owner, scheduleId } = await aWeekOfBookings();

    const res = await api().get('/api/class-bookings')
      .query({ scheduleId }).set('Cookie', owner.cookie);

    expect(rows(res.body)).toHaveLength(3);
  });
});
