import { beforeEach, describe, expect, it } from 'vitest';
import prisma from '../../src/db.js';
import {
  addMember, addMembership, addPlan, addUser, api, cookieFor, makeGym, resetDb,
} from '../helpers.js';

beforeEach(resetDb);

/**
 * What a member can see and do about themselves.
 *
 * The point of every endpoint here is that it takes the member off the session
 * rather than off the URL, so most of these tests are about what a member
 * *cannot* reach: somebody else's history, somebody else's booking, and a
 * place in a class they have not paid for. The happy paths are the smaller
 * half.
 */

/** A gym with a member who can sign in, plus a class they could book into. */
const aGymWithMember = async (opts: { expired?: boolean } = {}) => {
  const owner = await makeGym();
  const member = await addMember(owner.gymId, { name: 'Ali Khan' });
  const plan = await addPlan(owner.gymId);
  await addMembership(owner.gymId, member.id, {
    planId: plan.id,
    // A membership that ran out months ago is lapsed, which is what the
    // roster calls inactive.
    expiresInDays: opts.expired ? -120 : 20,
  });

  const account = await addUser(owner.gymId, {
    role: 'member',
    memberId: member.id,
  });

  return { owner, member, plan, account };
};

/** A class slot on a known weekday, so a booking date can be chosen for it. */
const aSchedule = async (
  gymId: string,
  opts: { dayOfWeek?: number; capacity?: number; name?: string } = {},
) => {
  const { dayOfWeek = 1, capacity = 20, name = 'Yoga' } = opts;
  const cls = await prisma.class.create({ data: { gymId, name } });
  return prisma.classSchedule.create({
    data: {
      gymId,
      classId: cls.id,
      dayOfWeek,
      startTime: '09:00',
      endTime: '10:00',
      capacity,
    },
  });
};

/** The next date falling on `dayOfWeek`, at midnight — what a booking needs. */
const nextDayOfWeek = (dayOfWeek: number): Date => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((dayOfWeek - d.getDay() + 7) % 7 || 7));
  return d;
};

describe('a member reading their own history', () => {
  it('lists every membership they have held, newest first', async () => {
    const { owner, member, plan, account } = await aGymWithMember();
    // Two older ones, superseded by the current membership.
    for (const days of [-400, -200]) {
      await addMembership(owner.gymId, member.id, {
        planId: plan.id,
        expiresInDays: days,
        status: 'superseded',
      });
    }

    const res = await api().get('/api/me/memberships').set('Cookie', account.cookie);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.data).toHaveLength(3);
    // The plan travels with it, since a member reads the name rather than an id.
    expect(res.body.data[0].planName).toBe('Monthly');
  });

  it('pages that history', async () => {
    const { owner, member, plan, account } = await aGymWithMember();
    for (let i = 0; i < 8; i++) {
      await addMembership(owner.gymId, member.id, {
        planId: plan.id,
        expiresInDays: -30 * (i + 2),
        status: 'superseded',
      });
    }

    const res = await api()
      .get('/api/me/memberships?limit=4')
      .set('Cookie', account.cookie);

    expect(res.body.data).toHaveLength(4);
    expect(res.body.total).toBe(9);
    expect(res.body.hasMore).toBe(true);
  });

  it('lists what they bought over the counter, naming the product', async () => {
    const { owner, member, account } = await aGymWithMember();
    const supplement = await prisma.supplement.create({
      data: { gymId: owner.gymId, name: 'Whey Protein', category: 'protein', price: 5000 },
    });
    await prisma.supplementSale.create({
      data: {
        gymId: owner.gymId,
        supplementId: supplement.id,
        memberId: member.id,
        quantity: 2,
        unitPrice: 5000,
        total: 10000,
      },
    });

    const res = await api().get('/api/me/purchases').set('Cookie', account.cookie);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    // The product name is the point: a payment row of type `supplement` knows
    // the money but not what was handed over.
    expect(res.body.data[0].supplementName).toBe('Whey Protein');
    expect(res.body.data[0].quantity).toBe(2);
    expect(res.body.data[0].total).toBe(10000);
  });

  it('never shows another member their history', async () => {
    const { owner, account } = await aGymWithMember();
    const other = await addMember(owner.gymId, { name: 'Someone Else' });
    const plan = await addPlan(owner.gymId, { name: 'Other plan' });
    await addMembership(owner.gymId, other.id, { planId: plan.id, expiresInDays: 10 });
    const supplement = await prisma.supplement.create({
      data: { gymId: owner.gymId, name: 'Creatine', category: 'creatine', price: 3000 },
    });
    await prisma.supplementSale.create({
      data: {
        gymId: owner.gymId,
        supplementId: supplement.id,
        memberId: other.id,
        quantity: 1,
        unitPrice: 3000,
        total: 3000,
      },
    });

    // Scoped by the session, and there is no id in either URL to point
    // elsewhere — which is the whole security argument for this router.
    const memberships = await api()
      .get('/api/me/memberships')
      .set('Cookie', account.cookie);
    const purchases = await api()
      .get('/api/me/purchases')
      .set('Cookie', account.cookie);

    expect(memberships.body.total).toBe(1);
    expect(memberships.body.data[0].planName).toBe('Monthly');
    expect(purchases.body.total).toBe(0);
  });

  it('tells a staff account it is not a member, rather than forbidding it', async () => {
    const owner = await makeGym();

    const res = await api().get('/api/me/memberships').set('Cookie', owner.cookie);

    // Truer than a 403: the owner is not forbidden, they are not a member.
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not linked to a member record');
  });
});

describe('the timetable a member is offered', () => {
  it('marks which sessions they are already in', async () => {
    const { owner, member, account } = await aGymWithMember();
    const schedule = await aSchedule(owner.gymId, { dayOfWeek: 1 });
    const other = await aSchedule(owner.gymId, { dayOfWeek: 1, name: 'Spin' });
    const day = nextDayOfWeek(1);

    await prisma.classBooking.create({
      data: {
        gymId: owner.gymId,
        scheduleId: schedule.id,
        memberId: member.id,
        bookingDate: day,
      },
    });

    const res = await api()
      .get(`/api/me/schedule?date=${day.toISOString()}`)
      .set('Cookie', account.cookie);

    expect(res.status).toBe(200);
    const booked = res.body.find((s: { id: string }) => s.id === schedule.id);
    const free = res.body.find((s: { id: string }) => s.id === other.id);
    expect(booked.booked).toBe(true);
    expect(free.booked).toBe(false);
  });

  it('counts other people without naming them', async () => {
    const { owner, account } = await aGymWithMember();
    const schedule = await aSchedule(owner.gymId, { dayOfWeek: 1, capacity: 5 });
    const day = nextDayOfWeek(1);

    for (let i = 0; i < 3; i++) {
      const other = await addMember(owner.gymId, { name: `Other ${i}` });
      await prisma.classBooking.create({
        data: {
          gymId: owner.gymId,
          scheduleId: schedule.id,
          memberId: other.id,
          bookingDate: day,
        },
      });
    }

    const res = await api()
      .get(`/api/me/schedule?date=${day.toISOString()}`)
      .set('Cookie', account.cookie);

    const slot = res.body[0];
    expect(slot.bookingsCount).toBe(3);
    expect(slot.remainingCapacity).toBe(2);
    expect(slot.booked).toBe(false);
    // Only the count travels. Who else is in the class is nobody's business.
    expect(JSON.stringify(slot)).not.toContain('memberId');
  });
});

describe('a member booking themselves in', () => {
  it('takes a place, and says so on the timetable afterwards', async () => {
    const { owner, account } = await aGymWithMember();
    const schedule = await aSchedule(owner.gymId, { dayOfWeek: 1 });
    const day = nextDayOfWeek(1);

    const res = await api()
      .post('/api/me/bookings')
      .set('Cookie', account.cookie)
      .send({ scheduleId: schedule.id, bookingDate: day.toISOString() });

    expect(res.status).toBe(201);

    const timetable = await api()
      .get(`/api/me/schedule?date=${day.toISOString()}`)
      .set('Cookie', account.cookie);
    expect(timetable.body[0].booked).toBe(true);
  });

  it('books the member on the session, whatever the body says', async () => {
    const { owner, member, account } = await aGymWithMember();
    const victim = await addMember(owner.gymId, { name: 'Not Me' });
    const schedule = await aSchedule(owner.gymId, { dayOfWeek: 1 });
    const day = nextDayOfWeek(1);

    const res = await api()
      .post('/api/me/bookings')
      .set('Cookie', account.cookie)
      // There is no `memberId` field in the schema, so this is dropped rather
      // than honoured — the strongest version of that guarantee is the one
      // where the value never arrives.
      .send({
        scheduleId: schedule.id,
        bookingDate: day.toISOString(),
        memberId: victim.id,
      });

    expect(res.status).toBe(201);
    const booking = await prisma.classBooking.findFirstOrThrow({
      where: { scheduleId: schedule.id },
    });
    expect(booking.memberId).toBe(member.id);
  });

  it('refuses a lapsed member, and says to renew', async () => {
    const { owner, account } = await aGymWithMember({ expired: true });
    const schedule = await aSchedule(owner.gymId, { dayOfWeek: 1 });
    const day = nextDayOfWeek(1);

    const res = await api()
      .post('/api/me/bookings')
      .set('Cookie', account.cookie)
      .send({ scheduleId: schedule.id, bookingDate: day.toISOString() });

    // Unlike check-in, which lets anybody through: waving somebody in costs
    // nothing, while holding a place takes it from a paying member.
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('membership_inactive');
    expect(await prisma.classBooking.count()).toBe(0);
  });

  it('refuses when the class is full', async () => {
    const { owner, account } = await aGymWithMember();
    const schedule = await aSchedule(owner.gymId, { dayOfWeek: 1, capacity: 1 });
    const day = nextDayOfWeek(1);

    const other = await addMember(owner.gymId, { name: 'Got there first' });
    await prisma.classBooking.create({
      data: {
        gymId: owner.gymId,
        scheduleId: schedule.id,
        memberId: other.id,
        bookingDate: day,
      },
    });

    const res = await api()
      .post('/api/me/bookings')
      .set('Cookie', account.cookie)
      .send({ scheduleId: schedule.id, bookingDate: day.toISOString() });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('fully booked');
  });

  it('refuses a date that is not the class day', async () => {
    const { owner, account } = await aGymWithMember();
    const schedule = await aSchedule(owner.gymId, { dayOfWeek: 1 });
    // A slot recurs weekly on one day, so another day is a session that does
    // not exist.
    const wrongDay = nextDayOfWeek(3);

    const res = await api()
      .post('/api/me/bookings')
      .set('Cookie', account.cookie)
      .send({ scheduleId: schedule.id, bookingDate: wrongDay.toISOString() });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('day of the week');
  });

  it('will not book the same session twice', async () => {
    const { owner, account } = await aGymWithMember();
    const schedule = await aSchedule(owner.gymId, { dayOfWeek: 1 });
    const day = nextDayOfWeek(1);
    const body = { scheduleId: schedule.id, bookingDate: day.toISOString() };

    expect(
      (await api().post('/api/me/bookings').set('Cookie', account.cookie).send(body))
        .status,
    ).toBe(201);

    const again = await api()
      .post('/api/me/bookings')
      .set('Cookie', account.cookie)
      .send(body);
    expect(again.status).toBe(400);
    expect(again.body.error).toContain('Already booked');
  });

  it('cannot reach another gym class', async () => {
    const { account } = await aGymWithMember();
    const otherGym = await makeGym({ gymName: 'Someone else' });
    const schedule = await aSchedule(otherGym.gymId, { dayOfWeek: 1 });
    const day = nextDayOfWeek(1);

    const res = await api()
      .post('/api/me/bookings')
      .set('Cookie', account.cookie)
      .send({ scheduleId: schedule.id, bookingDate: day.toISOString() });

    expect(res.status).toBe(404);
  });
});

describe('a member cancelling', () => {
  it('frees the place for somebody else', async () => {
    const { owner, account } = await aGymWithMember();
    const schedule = await aSchedule(owner.gymId, { dayOfWeek: 1, capacity: 1 });
    const day = nextDayOfWeek(1);

    const booked = await api()
      .post('/api/me/bookings')
      .set('Cookie', account.cookie)
      .send({ scheduleId: schedule.id, bookingDate: day.toISOString() });

    const cancelled = await api()
      .delete(`/api/me/bookings/${booked.body.id}`)
      .set('Cookie', account.cookie);

    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');

    // The place is genuinely free, not merely marked: the count that guards
    // capacity excludes cancellations.
    const timetable = await api()
      .get(`/api/me/schedule?date=${day.toISOString()}`)
      .set('Cookie', account.cookie);
    expect(timetable.body[0].remainingCapacity).toBe(1);
  });

  it('cannot cancel somebody else\'s booking', async () => {
    const { owner, account } = await aGymWithMember();
    const other = await addMember(owner.gymId, { name: 'Not Me' });
    const schedule = await aSchedule(owner.gymId, { dayOfWeek: 1 });
    const day = nextDayOfWeek(1);
    const theirs = await prisma.classBooking.create({
      data: {
        gymId: owner.gymId,
        scheduleId: schedule.id,
        memberId: other.id,
        bookingDate: day,
      },
    });

    const res = await api()
      .delete(`/api/me/bookings/${theirs.id}`)
      .set('Cookie', account.cookie);

    // 404 rather than 403: saying "forbidden" would confirm the id belongs to
    // a real booking.
    expect(res.status).toBe(404);
    expect(
      (await prisma.classBooking.findUniqueOrThrow({ where: { id: theirs.id } }))
        .status,
    ).toBe('booked');
  });

  it('will not rewrite an attendance that already happened', async () => {
    const { owner, member, account } = await aGymWithMember();
    const schedule = await aSchedule(owner.gymId, { dayOfWeek: 1 });
    const day = nextDayOfWeek(1);
    const attended = await prisma.classBooking.create({
      data: {
        gymId: owner.gymId,
        scheduleId: schedule.id,
        memberId: member.id,
        bookingDate: day,
        status: 'attended',
      },
    });

    const res = await api()
      .delete(`/api/me/bookings/${attended.id}`)
      .set('Cookie', account.cookie);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('already been attended');
  });

  it('is quiet about cancelling twice', async () => {
    const { owner, account } = await aGymWithMember();
    const schedule = await aSchedule(owner.gymId, { dayOfWeek: 1 });
    const day = nextDayOfWeek(1);
    const booked = await api()
      .post('/api/me/bookings')
      .set('Cookie', account.cookie)
      .send({ scheduleId: schedule.id, bookingDate: day.toISOString() });

    await api()
      .delete(`/api/me/bookings/${booked.body.id}`)
      .set('Cookie', account.cookie);
    const again = await api()
      .delete(`/api/me/bookings/${booked.body.id}`)
      .set('Cookie', account.cookie);

    // The member's intent is already satisfied; an error for a double tap
    // trains people to ignore errors.
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('cancelled');
  });

  it('lists the member\'s own bookings, cancelled ones included', async () => {
    const { owner, account } = await aGymWithMember();
    const schedule = await aSchedule(owner.gymId, { dayOfWeek: 1 });
    const day = nextDayOfWeek(1);
    const booked = await api()
      .post('/api/me/bookings')
      .set('Cookie', account.cookie)
      .send({ scheduleId: schedule.id, bookingDate: day.toISOString() });
    await api()
      .delete(`/api/me/bookings/${booked.body.id}`)
      .set('Cookie', account.cookie);

    const res = await api().get('/api/me/bookings').set('Cookie', account.cookie);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    // Kept rather than hidden: "I cancelled that" is a thing a member looks up.
    expect(res.body.data[0].status).toBe('cancelled');
    expect(res.body.data[0].className).toBe('Yoga');
  });
});

describe('the audit trail', () => {
  it('says a place was taken from the portal, not by the desk', async () => {
    const { owner, account } = await aGymWithMember();
    const schedule = await aSchedule(owner.gymId, { dayOfWeek: 1 });
    const day = nextDayOfWeek(1);

    await api()
      .post('/api/me/bookings')
      .set('Cookie', account.cookie)
      .send({ scheduleId: schedule.id, bookingDate: day.toISOString() });

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { gymId: owner.gymId, entity: 'classBooking' },
    });
    // A distinct action from `classBooking.create`, so the trail can tell the
    // two apart rather than showing every booking as staff work.
    expect(log.action).toBe('classBooking.selfCreate');
    expect(log.actorRole).toBe('member');
  });
});

describe('cookies from a deactivated account', () => {
  it('cannot book', async () => {
    const { owner, account } = await aGymWithMember();
    const schedule = await aSchedule(owner.gymId, { dayOfWeek: 1 });
    const day = nextDayOfWeek(1);
    await prisma.user.update({
      where: { id: account.userId },
      data: { isActive: false },
    });

    const res = await api()
      .post('/api/me/bookings')
      .set('Cookie', cookieFor(account.userId))
      .send({ scheduleId: schedule.id, bookingDate: day.toISOString() });

    expect(res.status).toBe(401);
  });
});
