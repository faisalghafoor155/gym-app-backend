import { beforeEach, describe, expect, it } from 'vitest';
import prisma from '../../src/db.js';
import { addMember, addPlan, api, makeGym, resetDb } from '../helpers.js';

beforeEach(resetDb);

/**
 * The lists that used to answer with a bare array and now answer with a page.
 *
 * Every one of these grows without bound in a working gym — a two-year-old
 * membership history, a season of PT sessions, a shelf of stock — and each was
 * returning all of it on every request. What is asserted here is the contract
 * that replaced that: a page of rows, a total covering the whole filtered set,
 * and `hasMore` saying whether pressing on would find anything.
 *
 * The `all=true` cases matter as much as the paged ones. Several of these lists
 * feed a dropdown rather than a table, and a picker that silently stopped at
 * the page size would make later rows unselectable — which reads as data having
 * gone missing rather than as a list having been shortened.
 */

/** The envelope every one of these endpoints now answers with. */
const expectEnvelope = (body: unknown, rows: number, total: number) => {
  const page = body as { data: unknown[]; total: number; hasMore: boolean };
  expect(page.data).toHaveLength(rows);
  expect(page.total).toBe(total);
  expect(page.hasMore).toBe(rows < total);
};

describe('supplements', () => {
  const addStock = (gymId: string, name: string, over: Record<string, unknown> = {}) =>
    prisma.supplement.create({
      data: { gymId, name, category: 'protein', price: 1000, stock: 5, ...over },
    });

  it('returns one page, and says how much is left', async () => {
    const owner = await makeGym();
    for (let i = 0; i < 5; i++) await addStock(owner.gymId, `Product ${i}`);

    const res = await api()
      .get('/api/supplements?limit=2')
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    expectEnvelope(res.body, 2, 5);
  });

  it('counts the whole shelf, not the page', async () => {
    const owner = await makeGym();
    await addStock(owner.gymId, 'Whey', { category: 'protein' });
    await addStock(owner.gymId, 'Mono', { category: 'creatine' });
    await addStock(owner.gymId, 'Empty tub', { category: 'protein', stock: 0 });

    const res = await api()
      .get('/api/supplements?limit=1')
      .set('Cookie', owner.cookie);

    // One row came back, but the chips describe all three: a count taken from
    // the page would climb as the user pressed Show more.
    expect(res.body.data).toHaveLength(1);
    expect(res.body.counts.all).toBe(3);
    expect(res.body.counts.byCategory.protein).toBe(2);
    expect(res.body.counts.byCategory.creatine).toBe(1);
    expect(res.body.counts.outOfStock).toBe(1);
  });

  it('searches the whole shelf rather than the loaded page', async () => {
    const owner = await makeGym();
    await addStock(owner.gymId, 'Whey Isolate');
    for (let i = 0; i < 30; i++) await addStock(owner.gymId, `Filler ${i}`);

    // The match is well past the first page, so a client-side filter would
    // never have found it.
    const res = await api()
      .get('/api/supplements?search=isolate')
      .set('Cookie', owner.cookie);

    expectEnvelope(res.body, 1, 1);
    expect(res.body.data[0].name).toBe('Whey Isolate');
  });

  it('hands the till everything when asked', async () => {
    const owner = await makeGym();
    for (let i = 0; i < 30; i++) await addStock(owner.gymId, `Product ${i}`);

    const res = await api()
      .get('/api/supplements?all=true')
      .set('Cookie', owner.cookie);

    // The POS cart cannot sell what the picker declined to list.
    expectEnvelope(res.body, 30, 30);
  });
});

describe('trainers', () => {
  const addTrainer = (gymId: string, name: string, isActive = true) =>
    prisma.trainer.create({ data: { gymId, name, commissionPercentage: 10, isActive } });

  it('returns one page of trainers', async () => {
    const owner = await makeGym();
    for (let i = 0; i < 4; i++) await addTrainer(owner.gymId, `Coach ${i}`);

    const res = await api().get('/api/trainers?limit=2').set('Cookie', owner.cookie);

    expectEnvelope(res.body, 2, 4);
  });

  it('leaves out the ones who have left, until asked for them', async () => {
    const owner = await makeGym();
    await addTrainer(owner.gymId, 'Still here');
    await addTrainer(owner.gymId, 'Moved on', false);

    const working = await api().get('/api/trainers').set('Cookie', owner.cookie);
    expectEnvelope(working.body, 1, 1);
    expect(working.body.data[0].name).toBe('Still here');

    const everyone = await api()
      .get('/api/trainers?includeInactive=true')
      .set('Cookie', owner.cookie);
    expectEnvelope(everyone.body, 2, 2);
  });

  it('gives a picker every trainer', async () => {
    const owner = await makeGym();
    for (let i = 0; i < 30; i++) await addTrainer(owner.gymId, `Coach ${i}`);

    const res = await api().get('/api/trainers?all=true').set('Cookie', owner.cookie);

    // A trainer missing from the dropdown is a trainer nobody can be assigned.
    expectEnvelope(res.body, 30, 30);
  });
});

describe('membership plans', () => {
  it('pages, and offers everything to the sale form', async () => {
    const owner = await makeGym();
    for (let i = 0; i < 5; i++) {
      await addPlan(owner.gymId, { name: `Plan ${i}`, durationDays: 30 + i });
    }

    const paged = await api()
      .get('/api/membership-plans?limit=2')
      .set('Cookie', owner.cookie);
    expectEnvelope(paged.body, 2, 5);

    const all = await api()
      .get('/api/membership-plans?all=true')
      .set('Cookie', owner.cookie);
    expectEnvelope(all.body, 5, 5);
  });
});

describe("a member's membership history", () => {
  it('pages, newest first', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const plan = await addPlan(owner.gymId);

    // A member who has renewed monthly for a year — the case this list is
    // opened for, and the one it was longest for.
    for (let i = 0; i < 12; i++) {
      await prisma.membership.create({
        data: {
          gymId: owner.gymId,
          memberId: member.id,
          planId: plan.id,
          startDate: new Date(2026, i, 1),
          expiryDate: new Date(2026, i + 1, 1),
          pricePaid: 2500,
          status: i === 11 ? 'active' : 'superseded',
        },
      });
    }

    const res = await api()
      .get(`/api/members/${member.id}/memberships?limit=5`)
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    expectEnvelope(res.body, 5, 12);
  });
});

describe('classes and bookings', () => {
  it('pages the catalogue and hands the picker all of it', async () => {
    const owner = await makeGym();
    for (let i = 0; i < 5; i++) {
      await prisma.class.create({ data: { gymId: owner.gymId, name: `Class ${i}` } });
    }

    const paged = await api().get('/api/classes?limit=2').set('Cookie', owner.cookie);
    expectEnvelope(paged.body, 2, 5);

    const all = await api().get('/api/classes?all=true').set('Cookie', owner.cookie);
    expectEnvelope(all.body, 5, 5);
  });

  it('pages bookings and still filters them by day', async () => {
    const owner = await makeGym();
    const cls = await prisma.class.create({
      data: { gymId: owner.gymId, name: 'Yoga' },
    });
    const schedule = await prisma.classSchedule.create({
      data: {
        gymId: owner.gymId,
        classId: cls.id,
        dayOfWeek: 1,
        startTime: '09:00',
        endTime: '10:00',
        capacity: 50,
      },
    });

    const day = new Date(2026, 7, 24);
    for (let i = 0; i < 4; i++) {
      const member = await addMember(owner.gymId, { name: `Member ${i}` });
      await prisma.classBooking.create({
        data: {
          gymId: owner.gymId,
          scheduleId: schedule.id,
          memberId: member.id,
          bookingDate: day,
        },
      });
    }

    const res = await api()
      .get('/api/class-bookings?date=2026-08-24&limit=3')
      .set('Cookie', owner.cookie);

    expectEnvelope(res.body, 3, 4);
  });

  it('still matches a day filter that carries a time', async () => {
    const owner = await makeGym();
    const cls = await prisma.class.create({
      data: { gymId: owner.gymId, name: 'Yoga' },
    });
    const schedule = await prisma.classSchedule.create({
      data: {
        gymId: owner.gymId,
        classId: cls.id,
        dayOfWeek: 1,
        startTime: '09:00',
        endTime: '10:00',
        capacity: 50,
      },
    });
    const member = await addMember(owner.gymId);
    await prisma.classBooking.create({
      data: {
        gymId: owner.gymId,
        scheduleId: schedule.id,
        memberId: member.id,
        bookingDate: new Date(2026, 7, 24),
      },
    });

    // Normalising to midnight moved into the schema with the paging; without
    // it this finds nothing and reads as an empty timetable.
    const res = await api()
      .get('/api/class-bookings?date=2026-08-24T18:00:00')
      .set('Cookie', owner.cookie);

    expectEnvelope(res.body, 1, 1);
  });

  it('rejects a booking status that is not one', async () => {
    const owner = await makeGym();

    const res = await api()
      .get('/api/class-bookings?status=nonsense')
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(400);
  });
});

describe('PT sessions', () => {
  it('pages the log', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const trainer = await prisma.trainer.create({
      data: { gymId: owner.gymId, name: 'Coach', commissionPercentage: 20 },
    });

    for (let i = 0; i < 6; i++) {
      await prisma.ptSession.create({
        data: {
          gymId: owner.gymId,
          memberId: member.id,
          trainerId: trainer.id,
          sessionDate: new Date(2026, 7, i + 1),
          priceCharged: 2000,
          trainerCommission: 400,
          status: 'completed',
        },
      });
    }

    const res = await api()
      .get('/api/pt-sessions?limit=4')
      .set('Cookie', owner.cookie);

    expectEnvelope(res.body, 4, 6);
  });

  it('rejects a status the log does not have', async () => {
    const owner = await makeGym();

    // Previously this reached Prisma as a filter matching nothing, and an
    // empty log is indistinguishable from a working one.
    const res = await api()
      .get('/api/pt-sessions?status=nonsense')
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(400);
  });
});

describe('payouts', () => {
  it('keeps a departed trainer on the list while they are still owed', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const trainer = await prisma.trainer.create({
      data: {
        gymId: owner.gymId,
        name: 'Moved on',
        commissionPercentage: 30,
        isActive: false,
      },
    });
    await prisma.ptSession.create({
      data: {
        gymId: owner.gymId,
        memberId: member.id,
        trainerId: trainer.id,
        sessionDate: new Date(),
        priceCharged: 4000,
        trainerCommission: 1200,
        status: 'completed',
      },
    });

    const res = await api().get('/api/payouts').set('Cookie', owner.cookie);

    // Unlike the trainers list, this one defaults to everyone: leaving does not
    // forfeit commission already earned, and hiding them writes off money the
    // gym still owes.
    expectEnvelope(res.body, 1, 1);
    expect(res.body.data[0].unpaidCommission).toBe(1200);

    const working = await api()
      .get('/api/payouts?activeOnly=true')
      .set('Cookie', owner.cookie);
    expectEnvelope(working.body, 0, 0);
  });

  it('totals each trainer without loading their whole history', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const trainer = await prisma.trainer.create({
      data: { gymId: owner.gymId, name: 'Coach', commissionPercentage: 25 },
    });

    for (const payoutStatus of ['paid', 'paid', 'unpaid'] as const) {
      await prisma.ptSession.create({
        data: {
          gymId: owner.gymId,
          memberId: member.id,
          trainerId: trainer.id,
          sessionDate: new Date(),
          priceCharged: 2000,
          trainerCommission: 500,
          status: 'completed',
          payoutStatus,
        },
      });
    }

    const res = await api().get('/api/payouts').set('Cookie', owner.cookie);

    const row = res.body.data[0];
    expect(row.totalSessionsCount).toBe(3);
    expect(row.paidCommission).toBe(1000);
    expect(row.unpaidCommission).toBe(500);
    expect(row.totalEarned).toBe(1500);
  });

  it('reports a trainer with no sessions as zero rather than omitting them', async () => {
    const owner = await makeGym();
    await prisma.trainer.create({
      data: { gymId: owner.gymId, name: 'Just hired', commissionPercentage: 10 },
    });

    const res = await api().get('/api/payouts').set('Cookie', owner.cookie);

    // No row in the grouping at all — which is a zero, not a gap.
    expectEnvelope(res.body, 1, 1);
    expect(res.body.data[0].totalSessionsCount).toBe(0);
    expect(res.body.data[0].totalEarned).toBe(0);
  });
});

describe('the team list', () => {
  it('pages while keeping the seat count beside it', async () => {
    const owner = await makeGym();
    for (let i = 0; i < 4; i++) {
      await prisma.user.create({
        data: {
          gymId: owner.gymId,
          email: `staff-${i}@example.com`,
          name: `Staff ${i}`,
          role: 'staff',
          staffPermission: 'receptionist',
        },
      });
    }

    const res = await api().get('/api/users?limit=2').set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    // The rows stay under `users`, not `data`: the seat count travels with
    // them, so this was never the bare envelope the other lists answer with.
    expect(res.body.users).toHaveLength(2);
    expect(res.body.total).toBe(5);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.seats).toBeDefined();
  });
});

describe('paging limits', () => {
  it('refuses a limit past the cap rather than returning the table', async () => {
    const owner = await makeGym();

    const res = await api()
      .get('/api/trainers?limit=5000')
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(400);
  });

  it('refuses a page before the first', async () => {
    const owner = await makeGym();

    const res = await api().get('/api/classes?page=0').set('Cookie', owner.cookie);

    expect(res.status).toBe(400);
  });
});
