import { beforeEach, describe, expect, it } from 'vitest';

import prisma from '../../src/db.js';
import { addMember, addPlan, api, makeGym, resetDb } from '../helpers.js';

/**
 * Tenant isolation: one gym must never be able to read or change another's
 * data.
 *
 * This is the single most important property in the app — every other bug is
 * one gym's problem, but a scoping bug is everybody's. So it is checked at the
 * HTTP boundary, with a real second gym holding real rows, rather than by
 * trusting that each query happens to carry a `gymId`.
 *
 * The pattern throughout: gym A signs in, aims a request at a row that belongs
 * to gym B, and must be refused — and B's row must be untouched afterwards.
 */

beforeEach(resetDb);

/** Two fully separate gyms, each with a member and a plan. */
const twoGyms = async () => {
  const a = await makeGym({ gymName: 'Gym A' });
  const b = await makeGym({ gymName: 'Gym B' });
  return {
    a: { ...a, member: await addMember(a.gymId, { name: 'Alice' }), plan: await addPlan(a.gymId) },
    b: { ...b, member: await addMember(b.gymId, { name: 'Bob' }), plan: await addPlan(b.gymId) },
  };
};

describe('members', () => {
  it('lists only the caller\'s own members', async () => {
    const { a } = await twoGyms();

    const res = await api().get('/api/members').set('Cookie', a.cookie);

    expect(res.status).toBe(200);
    expect(res.body.data.map((m: { name: string }) => m.name)).toEqual(['Alice']);
    // The counts are scoped too, or they would leak how many members the other
    // gym has even while its rows stay hidden.
    expect(res.body.total).toBe(1);
    expect(res.body.counts.all).toBe(1);
  });

  it('will not fetch another gym\'s member by id', async () => {
    const { a, b } = await twoGyms();

    const res = await api().get(`/api/members/${b.member.id}`).set('Cookie', a.cookie);

    // 404, not 403: confirming the id exists would itself leak that B has it.
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Bob');
  });

  it('will not update another gym\'s member', async () => {
    const { a, b } = await twoGyms();

    const res = await api().put(`/api/members/${b.member.id}`)
      .set('Cookie', a.cookie)
      .send({ name: 'Hijacked', phone: '03009999999' });

    expect(res.status).toBe(404);
    const after = await prisma.member.findUnique({ where: { id: b.member.id } });
    expect(after?.name).toBe('Bob');
  });

  it('will not delete another gym\'s member', async () => {
    const { a, b } = await twoGyms();

    const res = await api().delete(`/api/members/${b.member.id}`).set('Cookie', a.cookie);

    expect(res.status).toBe(404);
    expect(await prisma.member.findUnique({ where: { id: b.member.id } })).not.toBeNull();
  });

  it('ignores a gymId in the request body and uses the session\'s', async () => {
    const { a, b } = await twoGyms();

    const res = await api().post('/api/members')
      .set('Cookie', a.cookie)
      .send({ name: 'Planted', phone: '03001111111', gymId: b.gymId });

    expect(res.status).toBe(201);
    // The row must land in A regardless of what the body asked for.
    const planted = await prisma.member.findFirst({ where: { name: 'Planted' } });
    expect(planted?.gymId).toBe(a.gymId);
  });

  it('numbers each gym\'s members from its own counter', async () => {
    const { a, b } = await twoGyms();

    const inA = await api().post('/api/members').set('Cookie', a.cookie)
      .send({ name: 'Second A', phone: '03001111111' });
    const inB = await api().post('/api/members').set('Cookie', b.cookie)
      .send({ name: 'Second B', phone: '03002222222' });

    // Both gyms are on their second member, so both read MEM-00002 — a member
    // number must not hint at how many members the rest of the system has.
    expect(inA.body.memberNo).toBe('MEM-00002');
    expect(inB.body.memberNo).toBe('MEM-00002');
  });
});

describe('memberships and payments', () => {
  it('will not sell a membership using another gym\'s plan', async () => {
    const { a, b } = await twoGyms();

    const res = await api().post(`/api/members/${a.member.id}/memberships`)
      .set('Cookie', a.cookie)
      .send({ planId: b.plan.id, startDate: '2026-06-01' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.membership.count({ where: { planId: b.plan.id } })).toBe(0);
  });

  it('will not record a payment against another gym\'s member', async () => {
    const { a, b } = await twoGyms();

    const res = await api().post('/api/payments')
      .set('Cookie', a.cookie)
      .send({ memberId: b.member.id, amount: 2500, type: 'membership' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.payment.count({ where: { memberId: b.member.id } })).toBe(0);
  });

  it('keeps each gym\'s payment list separate', async () => {
    const { a, b } = await twoGyms();
    await api().post('/api/payments').set('Cookie', a.cookie)
      .send({ memberId: a.member.id, amount: 2500, type: 'membership' });
    await api().post('/api/payments').set('Cookie', b.cookie)
      .send({ memberId: b.member.id, amount: 9999, type: 'membership' });

    const res = await api().get('/api/payments').set('Cookie', a.cookie);
    const rows = res.body.data as { amount: number }[];

    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(2500);
    // The filtered totals are scoped as well: gym B's 9999 must not reach gym
    // A's header, which would leak its takings without ever showing its rows.
    expect(res.body.collected).toBe(2500);
  });
});

describe('attendance', () => {
  it('will not check in another gym\'s member', async () => {
    const { a, b } = await twoGyms();

    const res = await api().post('/api/attendance/checkin')
      .set('Cookie', a.cookie)
      .send({ memberId: b.member.id });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.attendance.count({ where: { memberId: b.member.id } })).toBe(0);
  });

  it('returns nothing for another gym\'s member rather than their history', async () => {
    const { a, b } = await twoGyms();
    await api().post('/api/attendance/checkin').set('Cookie', b.cookie)
      .send({ memberId: b.member.id });
    expect(await prisma.attendance.count({ where: { memberId: b.member.id } })).toBe(1);

    const res = await api().get(`/api/attendance/member/${b.member.id}`).set('Cookie', a.cookie);

    // The query is scoped by gymId, so this answers 200 with an empty list
    // rather than 404. Either is safe — what matters is that none of B's
    // check-ins come back.
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('supplements', () => {
  const addSupplement = (gymId: string) =>
    prisma.supplement.create({
      data: { gymId, name: 'Whey', category: 'protein', price: 5000, stock: 10 },
      select: { id: true },
    });

  it('lists only the caller\'s own stock', async () => {
    const { a, b } = await twoGyms();
    await addSupplement(a.gymId);
    await addSupplement(b.gymId);

    const res = await api().get('/api/supplements').set('Cookie', a.cookie);
    const rows = (res.body.supplements ?? res.body) as unknown[];

    expect(rows).toHaveLength(1);
  });

  it('will not sell from another gym\'s stock', async () => {
    const { a, b } = await twoGyms();
    const bStock = await addSupplement(b.gymId);

    const res = await api().post(`/api/supplements/${bStock.id}/sell`)
      .set('Cookie', a.cookie)
      .send({ quantity: 1 });

    expect(res.status).toBeGreaterThanOrEqual(400);
    // B's stock must be untouched — a leak here would be theft, not just a read.
    const after = await prisma.supplement.findUnique({ where: { id: bStock.id } });
    expect(after?.stock).toBe(10);
  });
});

describe('plans', () => {
  it('will not read another gym\'s assigned plans', async () => {
    const { a, b } = await twoGyms();

    const res = await api().get(`/api/plans/member/${b.member.id}`).set('Cookie', a.cookie);

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('trainers', () => {
  it('lists only the caller\'s own trainers', async () => {
    const { a, b } = await twoGyms();
    await api().post('/api/trainers').set('Cookie', a.cookie).send({ name: 'A Trainer' });
    await api().post('/api/trainers').set('Cookie', b.cookie).send({ name: 'B Trainer' });

    const res = await api().get('/api/trainers').set('Cookie', a.cookie);

    expect(res.status).toBe(200);
    const names = (res.body.data ?? res.body).map((t: { name: string }) => t.name);
    expect(names).toEqual(['A Trainer']);
  });

  it('will not update another gym\'s trainer', async () => {
    const { a, b } = await twoGyms();
    const made = await api().post('/api/trainers').set('Cookie', b.cookie).send({ name: 'B Trainer' });
    const trainerId = made.body.id ?? made.body.data?.id;

    const res = await api()
      .put(`/api/trainers/${trainerId}`)
      .set('Cookie', a.cookie)
      .send({ name: 'Hijacked' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    // The refusal must be a real one, not a 200 that quietly changed nothing.
    const after = await prisma.trainer.findUnique({ where: { id: trainerId } });
    expect(after?.name).toBe('B Trainer');
  });

  it('will not delete another gym\'s trainer', async () => {
    const { a, b } = await twoGyms();
    const made = await api().post('/api/trainers').set('Cookie', b.cookie).send({ name: 'B Trainer' });
    const trainerId = made.body.id ?? made.body.data?.id;

    const res = await api().delete(`/api/trainers/${trainerId}`).set('Cookie', a.cookie);

    expect(res.status).toBeGreaterThanOrEqual(400);
    // Deletion here is a soft delete, so the row surviving is not enough — it
    // must still be active.
    const after = await prisma.trainer.findUnique({ where: { id: trainerId } });
    expect(after).not.toBeNull();
    expect(after?.isActive).toBe(true);
  });
});

describe('classes', () => {
  it('lists only the caller\'s own classes', async () => {
    const { a, b } = await twoGyms();
    await api().post('/api/classes').set('Cookie', a.cookie).send({ name: 'A Yoga' });
    await api().post('/api/classes').set('Cookie', b.cookie).send({ name: 'B Spin' });

    const res = await api().get('/api/classes').set('Cookie', a.cookie);

    expect(res.status).toBe(200);
    const names = (res.body.data ?? res.body).map((c: { name: string }) => c.name);
    expect(names).toEqual(['A Yoga']);
  });

  it('will not schedule against another gym\'s class', async () => {
    const { a, b } = await twoGyms();
    const bClass = await api().post('/api/classes').set('Cookie', b.cookie).send({ name: 'B Spin' });
    const classId = bClass.body.id ?? bClass.body.data?.id;

    const res = await api()
      .post('/api/classes/schedules')
      .set('Cookie', a.cookie)
      .send({ classId, dayOfWeek: 1, startTime: '09:00', endTime: '10:00', capacity: 10 });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.classSchedule.count({ where: { classId } })).toBe(0);
  });

  it('will not borrow another gym\'s trainer for its own schedule', async () => {
    const { a, b } = await twoGyms();
    const aClass = await api().post('/api/classes').set('Cookie', a.cookie).send({ name: 'A Yoga' });
    const classId = aClass.body.id ?? aClass.body.data?.id;
    const bTrainer = await api().post('/api/trainers').set('Cookie', b.cookie).send({ name: 'B Trainer' });
    const trainerId = bTrainer.body.id ?? bTrainer.body.data?.id;

    // The class is A's own, so only the trainer crosses the boundary — that
    // alone has to be enough to refuse it.
    const res = await api()
      .post('/api/classes/schedules')
      .set('Cookie', a.cookie)
      .send({ classId, trainerId, dayOfWeek: 1, startTime: '09:00', endTime: '10:00', capacity: 10 });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.classSchedule.count({ where: { trainerId } })).toBe(0);
  });

  it('will not delete another gym\'s schedule', async () => {
    const { a, b } = await twoGyms();
    const bClass = await api().post('/api/classes').set('Cookie', b.cookie).send({ name: 'B Spin' });
    const classId = bClass.body.id ?? bClass.body.data?.id;
    const made = await api()
      .post('/api/classes/schedules')
      .set('Cookie', b.cookie)
      .send({ classId, dayOfWeek: 2, startTime: '18:00', endTime: '19:00', capacity: 15 });
    const scheduleId = made.body.id ?? made.body.data?.id;

    const res = await api().delete(`/api/classes/schedules/${scheduleId}`).set('Cookie', a.cookie);

    expect(res.status).toBeGreaterThanOrEqual(400);
    const after = await prisma.classSchedule.findUnique({ where: { id: scheduleId } });
    expect(after?.isActive).toBe(true);
  });
});

describe('pt sessions', () => {
  /** A PT session joins a member to a trainer, so it can cross the boundary
   *  from either side. Both directions are checked. */
  const aTrainerIn = async (cookie: string) => {
    const res = await api().post('/api/trainers').set('Cookie', cookie).send({ name: 'Coach' });
    return (res.body.id ?? res.body.data?.id) as string;
  };

  it('will not book another gym\'s member', async () => {
    const { a, b } = await twoGyms();
    const trainerId = await aTrainerIn(a.cookie);

    const res = await api().post('/api/pt-sessions').set('Cookie', a.cookie).send({
      memberId: b.member.id,
      trainerId,
      sessionDate: '2026-03-01',
      priceCharged: 1500,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.ptSession.count({ where: { memberId: b.member.id } })).toBe(0);
  });

  it('will not book another gym\'s trainer', async () => {
    const { a, b } = await twoGyms();
    const trainerId = await aTrainerIn(b.cookie);

    const res = await api().post('/api/pt-sessions').set('Cookie', a.cookie).send({
      memberId: a.member.id,
      trainerId,
      sessionDate: '2026-03-01',
      priceCharged: 1500,
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.ptSession.count({ where: { trainerId } })).toBe(0);
  });

  it('will not update another gym\'s session', async () => {
    const { a, b } = await twoGyms();
    const trainerId = await aTrainerIn(b.cookie);
    const made = await api().post('/api/pt-sessions').set('Cookie', b.cookie).send({
      memberId: b.member.id,
      trainerId,
      sessionDate: '2026-03-01',
      priceCharged: 1500,
    });
    const sessionId = made.body.id ?? made.body.data?.id;

    const res = await api()
      .put(`/api/pt-sessions/${sessionId}`)
      .set('Cookie', a.cookie)
      .send({ status: 'cancelled' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    const after = await prisma.ptSession.findUnique({ where: { id: sessionId } });
    expect(after?.status).not.toBe('cancelled');
  });

  it('lists and reports on the caller\'s own sessions only', async () => {
    const { a, b } = await twoGyms();
    const trainerId = await aTrainerIn(b.cookie);
    await api().post('/api/pt-sessions').set('Cookie', b.cookie).send({
      memberId: b.member.id,
      trainerId,
      sessionDate: '2026-03-01',
      priceCharged: 4321,
    });

    const list = await api().get('/api/pt-sessions').set('Cookie', a.cookie);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain('Bob');

    const commissions = await api().get('/api/pt-sessions/commissions').set('Cookie', a.cookie);
    expect(commissions.status).toBe(200);
    expect(JSON.stringify(commissions.body)).not.toContain('4321');
  });
});

describe('payouts', () => {
  it('reports payouts for the caller\'s own trainers only', async () => {
    const { a, b } = await twoGyms();
    const made = await api().post('/api/trainers').set('Cookie', b.cookie).send({ name: 'B Coach' });
    const trainerId = made.body.id ?? made.body.data?.id;
    await api().post('/api/pt-sessions').set('Cookie', b.cookie).send({
      memberId: b.member.id,
      trainerId,
      sessionDate: '2026-03-01',
      priceCharged: 4321,
    });

    const res = await api().get('/api/payouts').set('Cookie', a.cookie);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('B Coach');
    expect(JSON.stringify(res.body)).not.toContain(trainerId);
  });
});

// Expenses are already covered end to end in expenses.integration.test.ts
// ("never touches another gym's expenses", "shows one gym nothing of
// another's", "never counts another gym's money"), so they are not repeated
// here.

describe('reports', () => {
  it('reports attendance for the caller\'s own gym only', async () => {
    const { a, b } = await twoGyms();
    // Attendance recorded in B only. The analytics query is raw SQL, so its
    // scoping is checked here rather than inferred from the ORM.
    await api().post('/api/attendance').set('Cookie', b.cookie).send({ memberId: b.member.id });

    const res = await api().get('/api/analytics/attendance').set('Cookie', a.cookie);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(b.member.id);
    expect(JSON.stringify(res.body)).not.toContain('Bob');
  });
});

describe('dashboard', () => {
  it('counts only the caller\'s own gym', async () => {
    const { a, b } = await twoGyms();
    // Three more members in B, none in A.
    for (let i = 0; i < 3; i++) await addMember(b.gymId, { name: `Extra ${i}` });

    const res = await api().get('/api/dashboard').set('Cookie', a.cookie);

    expect(res.status).toBe(200);
    // A has exactly one member; B's four must not show up in A's totals.
    expect(JSON.stringify(res.body)).not.toContain('"4"');
    const totals = res.body as Record<string, unknown>;
    const memberCount = totals.totalMembers ?? totals.members ?? totals.memberCount;
    if (typeof memberCount === 'number') expect(memberCount).toBe(1);
  });
});
