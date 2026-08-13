import { beforeEach, describe, expect, it } from 'vitest';

import prisma from '../../src/db.js';
import { addDays } from '../../src/services/membership.js';
import { addMember, addPlan, addUser, api, makeGym, resetDb } from '../helpers.js';

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
    const rows = res.body.data as { amount: number }[];

    expect(rows[0].amount).toBe(1234.56);
    expect(typeof rows[0].amount).toBe('number');
    // The header totals cross as numbers too, for the same reason the rows do:
    // a Decimal would serialise as "1234.56" and every toLocaleString break.
    expect(res.body.collected).toBe(1234.56);
    expect(typeof res.body.collected).toBe('number');
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

/**
 * Paging the payments list, and the totals that sit above it.
 *
 * The totals are the part worth guarding. The page header says "matching
 * filters", so they have to cover every matching row rather than the page —
 * a figure that quietly totalled the first 25 payments while claiming to be
 * the filtered total would be wrong in the one direction money must never be.
 */
describe('payments list — paging and totals', () => {
  it('pages the rows', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    for (let i = 0; i < 5; i++) {
      await api().post('/api/payments').set('Cookie', owner.cookie)
        .send({ memberId: member.id, amount: 100, type: 'other' });
    }

    const res = await api().get('/api/payments?limit=2').set('Cookie', owner.cookie);

    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(5);
    expect(res.body.hasMore).toBe(true);
  });

  it('totals every matching payment, not the page', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    // Ten payments of 100, asked for two at a time.
    for (let i = 0; i < 10; i++) {
      await api().post('/api/payments').set('Cookie', owner.cookie)
        .send({ memberId: member.id, amount: 100, type: 'other' });
    }

    const res = await api().get('/api/payments?limit=2').set('Cookie', owner.cookie);

    expect(res.body.data).toHaveLength(2);
    expect(res.body.collected).toBe(1000);
  });

  it('splits paid from outstanding', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await api().post('/api/payments').set('Cookie', owner.cookie)
      .send({ memberId: member.id, amount: 2500, type: 'membership', status: 'paid' });
    await api().post('/api/payments').set('Cookie', owner.cookie)
      .send({ memberId: member.id, amount: 800, type: 'membership', status: 'due' });

    const res = await api().get('/api/payments').set('Cookie', owner.cookie);

    expect(res.body.collected).toBe(2500);
    expect(res.body.outstanding).toBe(800);
  });

  it('keeps the totals exact over payments a float would drift on', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    for (let i = 0; i < 10; i++) {
      await api().post('/api/payments').set('Cookie', owner.cookie)
        .send({ memberId: member.id, amount: 0.1, type: 'other' });
    }

    const res = await api().get('/api/payments?limit=3').set('Cookie', owner.cookie);

    // Ten 0.10s summed as floats give 0.9999999999999999. Summed as Decimals
    // in the database, and only then made a number, they give 1.
    expect(res.body.collected).toBe(1);
  });

  it('narrows the totals with the filters they claim to follow', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await api().post('/api/payments').set('Cookie', owner.cookie)
      .send({ memberId: member.id, amount: 2500, type: 'membership' });
    await api().post('/api/payments').set('Cookie', owner.cookie)
      .send({ memberId: member.id, amount: 300, type: 'supplement' });

    const res = await api().get('/api/payments?type=supplement').set('Cookie', owner.cookie);

    expect(res.body.total).toBe(1);
    expect(res.body.collected).toBe(300);
  });

  it('reports zero rather than nothing when a status has no rows', async () => {
    const owner = await makeGym();
    // groupBy omits an absent status entirely, so this is where an undefined
    // would leak out and render as "Rs. undefined".
    const res = await api().get('/api/payments').set('Cookie', owner.cookie);

    expect(res.body.collected).toBe(0);
    expect(res.body.outstanding).toBe(0);
  });

  it('totals only what a staff member took, as their rows are narrowed', async () => {
    const owner = await makeGym();
    const staff = await addUser(owner.gymId, { role: 'staff' });
    const member = await addMember(owner.gymId);

    await api().post('/api/payments').set('Cookie', owner.cookie)
      .send({ memberId: member.id, amount: 5000, type: 'membership' });
    await api().post('/api/payments').set('Cookie', staff.cookie)
      .send({ memberId: member.id, amount: 700, type: 'membership' });

    const asStaff = await api().get('/api/payments').set('Cookie', staff.cookie);
    const asOwner = await api().get('/api/payments').set('Cookie', owner.cookie);

    // The whole point of the staff narrowing is that they see their own till
    // and not the gym's income — a total that ignored it would hand them the
    // figure the rows were withheld to protect.
    expect(asStaff.body.total).toBe(1);
    expect(asStaff.body.collected).toBe(700);
    expect(asOwner.body.collected).toBe(5700);
  });
});
