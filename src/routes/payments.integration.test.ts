import { beforeEach, describe, expect, it } from 'vitest';

import prisma from '../db.js';
import { addDays } from '../services/membership.js';
import { addMember, addPlan, api, makeGym, resetDb } from '../test/helpers.js';

/**
 * Money through the real stack: Decimal in the database, plain numbers over
 * HTTP.
 *
 * The unit tests prove the helpers convert correctly in isolation. These prove
 * a controller actually calls them — a route that forgot `withMoney` would
 * start emitting `"2500"` and pass every unit test in the suite.
 */

beforeEach(resetDb);

/** A member holding an expired membership, which is what `due` reports on. */
const withExpiredMembership = async (
  gymId: string,
  opts: { price?: number; expiredDaysAgo?: number } = {},
) => {
  const { price = 2500, expiredDaysAgo = 10 } = opts;
  const member = await addMember(gymId);
  const plan = await addPlan(gymId, { price });
  const expiryDate = addDays(new Date(), -expiredDaysAgo);

  const membership = await prisma.membership.create({
    data: {
      gymId,
      memberId: member.id,
      planId: plan.id,
      startDate: addDays(expiryDate, -plan.durationDays),
      expiryDate,
      originalExpiryDate: expiryDate,
      pricePaid: price,
      status: 'active',
    },
    select: { id: true },
  });

  return { member, plan, membership };
};

describe('money crosses the API boundary as numbers', () => {
  it('returns a recorded payment amount as a number, not a string', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    const res = await api().post('/api/payments')
      .set('Cookie', owner.cookie)
      .send({ memberId: member.id, amount: 2500, type: 'membership' });

    expect(res.status).toBe(201);
    const created = res.body.payment ?? res.body;
    expect(typeof created.amount).toBe('number');
    expect(created.amount).toBe(2500);
  });

  it('keeps paisa through a round trip', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    await api().post('/api/payments').set('Cookie', owner.cookie)
      .send({ memberId: member.id, amount: 1234.56, type: 'other' });

    const res = await api().get('/api/payments').set('Cookie', owner.cookie);
    const rows = (res.body.payments ?? res.body) as { amount: number }[];

    expect(rows[0].amount).toBe(1234.56);
    expect(typeof rows[0].amount).toBe('number');
  });

  it('stores money as Decimal, so the database keeps the exact value', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    await api().post('/api/payments').set('Cookie', owner.cookie)
      .send({ memberId: member.id, amount: 0.1, type: 'other' });
    await api().post('/api/payments').set('Cookie', owner.cookie)
      .send({ memberId: member.id, amount: 0.2, type: 'other' });

    const total = await prisma.payment.aggregate({ _sum: { amount: true } });
    // 0.1 + 0.2 in binary floating point is 0.30000000000000004.
    expect(total._sum.amount?.toString()).toBe('0.3');
  });
});

describe('GET /api/payments/due', () => {
  it('reports the full price as outstanding when nothing has been paid', async () => {
    const owner = await makeGym();
    await withExpiredMembership(owner.gymId, { price: 2500 });

    const res = await api().get('/api/payments/due').set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ paid: 0, outstanding: 2500 });
  });

  it('subtracts a part payment', async () => {
    const owner = await makeGym();
    const { member, membership } = await withExpiredMembership(owner.gymId, { price: 2500 });

    await api().post('/api/payments').set('Cookie', owner.cookie)
      .send({ memberId: member.id, amount: 1000, type: 'membership', membershipId: membership.id });

    const res = await api().get('/api/payments/due').set('Cookie', owner.cookie);

    expect(res.body[0]).toMatchObject({ paid: 1000, outstanding: 1500 });
  });

  it('reports nothing outstanding once the membership is settled', async () => {
    const owner = await makeGym();
    const { member, membership } = await withExpiredMembership(owner.gymId, { price: 2500 });

    await api().post('/api/payments').set('Cookie', owner.cookie)
      .send({ memberId: member.id, amount: 2500, type: 'membership', membershipId: membership.id });

    const res = await api().get('/api/payments/due').set('Cookie', owner.cookie);

    // Still listed — the membership has expired, which is a separate fact from
    // owing money — but with the debt cleared.
    expect(res.body[0]).toMatchObject({ paid: 2500, outstanding: 0 });
  });

  it('never reports a negative outstanding after an overpayment', async () => {
    const owner = await makeGym();
    const { member, membership } = await withExpiredMembership(owner.gymId, { price: 2500 });

    await api().post('/api/payments').set('Cookie', owner.cookie)
      .send({ memberId: member.id, amount: 3000, type: 'membership', membershipId: membership.id });

    const res = await api().get('/api/payments/due').set('Cookie', owner.cookie);

    // A "-500 outstanding" would quietly cancel out somebody else's real debt
    // in a total.
    expect(res.body[0].outstanding).toBe(0);
    expect(res.body[0].paid).toBe(3000);
  });

  it('adds up several part payments exactly', async () => {
    const owner = await makeGym();
    const { member, membership } = await withExpiredMembership(owner.gymId, { price: 1000 });

    // Ten payments of 0.10 would drift to 0.9999999999999999 under float
    // addition, leaving a phantom 0.0000000000000001 outstanding.
    for (let i = 0; i < 10; i++) {
      await api().post('/api/payments').set('Cookie', owner.cookie).send({
        memberId: member.id, amount: 0.1, type: 'membership', membershipId: membership.id,
      });
    }

    const res = await api().get('/api/payments/due').set('Cookie', owner.cookie);

    expect(res.body[0].paid).toBe(1);
    expect(res.body[0].outstanding).toBe(999);
  });

  it('does not count a payment against another membership', async () => {
    const owner = await makeGym();
    const first = await withExpiredMembership(owner.gymId, { price: 2500 });
    const second = await withExpiredMembership(owner.gymId, { price: 3000 });

    await api().post('/api/payments').set('Cookie', owner.cookie).send({
      memberId: first.member.id, amount: 2500, type: 'membership',
      membershipId: first.membership.id,
    });

    const res = await api().get('/api/payments/due').set('Cookie', owner.cookie);
    const rows = res.body as { membership: { id: string }; outstanding: number }[];
    const other = rows.find(r => r.membership.id === second.membership.id);

    expect(other?.outstanding).toBe(3000);
  });

  it('leaves a current membership off the due list', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const plan = await addPlan(owner.gymId);
    const expiryDate = addDays(new Date(), 20);
    await prisma.membership.create({
      data: {
        gymId: owner.gymId, memberId: member.id, planId: plan.id,
        startDate: new Date(), expiryDate, originalExpiryDate: expiryDate,
        pricePaid: plan.price, status: 'active',
      },
    });

    const res = await api().get('/api/payments/due').set('Cookie', owner.cookie);

    expect(res.body).toEqual([]);
  });

  it('returns paid and outstanding as numbers', async () => {
    const owner = await makeGym();
    await withExpiredMembership(owner.gymId);

    const res = await api().get('/api/payments/due').set('Cookie', owner.cookie);

    expect(typeof res.body[0].paid).toBe('number');
    expect(typeof res.body[0].outstanding).toBe('number');
    expect(typeof res.body[0].membership.pricePaid).toBe('number');
  });
});

describe('payment validation', () => {
  it('rejects a negative amount', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    const res = await api().post('/api/payments')
      .set('Cookie', owner.cookie)
      .send({ memberId: member.id, amount: -500, type: 'membership' });

    expect(res.status).toBe(400);
    expect(await prisma.payment.count()).toBe(0);
  });

  it('rejects a payment for a member that does not exist', async () => {
    const owner = await makeGym();

    const res = await api().post('/api/payments')
      .set('Cookie', owner.cookie)
      .send({ memberId: crypto.randomUUID(), amount: 500, type: 'membership' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.payment.count()).toBe(0);
  });

  it('rejects an unknown payment type', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    const res = await api().post('/api/payments')
      .set('Cookie', owner.cookie)
      .send({ memberId: member.id, amount: 500, type: 'donation' });

    expect(res.status).toBe(400);
  });
});
