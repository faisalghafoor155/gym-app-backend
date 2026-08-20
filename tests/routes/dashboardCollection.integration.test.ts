import { beforeEach, describe, expect, it } from 'vitest';

import prisma from '../../src/db.js';
import { addDays } from '../../src/services/membership.js';
import { addMember, addPlan, addUser, api, makeGym, resetDb } from '../helpers.js';

/**
 * The dashboard's answer to "who has paid this month".
 *
 * The figure is computed from memberships rather than payments, and has to
 * agree with the Monthly Collection page — two screens disagreeing about how
 * many members still owe is worse than neither showing it.
 */

beforeEach(resetDb);

/** A membership covering today, optionally part- or fully-settled. */
const sellThisMonth = async (
  gymId: string,
  memberId: string,
  opts: { price: number; paid?: number } = { price: 2500 },
) => {
  const { price, paid = 0 } = opts;
  const plan = await addPlan(gymId, { price });
  const now = new Date();

  const membership = await prisma.membership.create({
    data: {
      gymId,
      memberId,
      planId: plan.id,
      // Spans today regardless of where in the month the suite runs.
      startDate: addDays(now, -3),
      expiryDate: addDays(now, 3),
      pricePaid: price,
      status: 'active',
    },
    select: { id: true },
  });

  if (paid > 0) {
    await prisma.payment.create({
      data: {
        gymId, memberId, membershipId: membership.id,
        amount: paid, status: 'paid', type: 'membership',
      },
    });
  }
  return membership;
};

const dashboard = (cookie: string) =>
  api().get('/api/dashboard').set('Cookie', cookie);

describe('dashboard — this month\'s fees', () => {
  it('counts who has settled and who has not', async () => {
    const owner = await makeGym();
    const paid = await addMember(owner.gymId, { name: 'Paid' });
    const partly = await addMember(owner.gymId, { name: 'Partly' });
    const none = await addMember(owner.gymId, { name: 'None' });

    await sellThisMonth(owner.gymId, paid.id, { price: 2000, paid: 2000 });
    await sellThisMonth(owner.gymId, partly.id, { price: 2000, paid: 500 });
    await sellThisMonth(owner.gymId, none.id, { price: 3000 });

    const res = await dashboard(owner.cookie);
    const c = res.body.revenue.collection;

    expect(c.settled).toBe(1);
    expect(c.pending).toBe(2);
    expect(c.collected).toBe(2500);
    expect(c.shortfall).toBe(4500);
    expect(c.expected).toBe(7000);
  });

  it('keeps collected and shortfall adding up to expected', async () => {
    const owner = await makeGym();
    for (const [name, price, paid] of [
      ['A', 1000, 1000], ['B', 2000, 750], ['C', 1500, 0],
    ] as const) {
      const m = await addMember(owner.gymId, { name });
      await sellThisMonth(owner.gymId, m.id, { price, paid });
    }

    const c = (await dashboard(owner.cookie)).body.revenue.collection;
    // The invariant the two tiles rest on: if these ever disagree, one of the
    // numbers on screen is lying.
    expect(c.collected + c.shortfall).toBe(c.expected);
  });

  it('does not let an overpayment mask somebody else\'s debt', async () => {
    const owner = await makeGym();
    const over = await addMember(owner.gymId, { name: 'Over' });
    const under = await addMember(owner.gymId, { name: 'Under' });

    await sellThisMonth(owner.gymId, over.id, { price: 1000, paid: 5000 });
    await sellThisMonth(owner.gymId, under.id, { price: 2000, paid: 0 });

    const c = (await dashboard(owner.cookie)).body.revenue.collection;

    // Collected is capped at what was owed, so a generous member cannot cancel
    // out a defaulter and make the month look settled.
    expect(c.collected).toBe(1000);
    expect(c.shortfall).toBe(2000);
    expect(c.pending).toBe(1);
  });

  it('agrees with the monthly collection page', async () => {
    const owner = await makeGym();
    const a = await addMember(owner.gymId, { name: 'A' });
    const b = await addMember(owner.gymId, { name: 'B' });

    await sellThisMonth(owner.gymId, a.id, { price: 2000, paid: 2000 });
    await sellThisMonth(owner.gymId, b.id, { price: 3000, paid: 1000 });

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const [dash, monthly] = await Promise.all([
      dashboard(owner.cookie),
      api().get(`/api/payments/monthly?month=${month}&view=unpaid`).set('Cookie', owner.cookie),
    ]);

    expect(dash.body.revenue.collection.pending).toBe(monthly.body.unpaid.length);
    expect(dash.body.revenue.collection.shortfall).toBe(monthly.body.shortfallTotal);
  });

  it('ignores memberships from other months', async () => {
    const owner = await makeGym();
    const current = await addMember(owner.gymId, { name: 'Current' });
    const old = await addMember(owner.gymId, { name: 'Old' });

    await sellThisMonth(owner.gymId, current.id, { price: 1000 });

    // Ended well before this month began.
    const plan = await addPlan(owner.gymId, { price: 9999 });
    await prisma.membership.create({
      data: {
        gymId: owner.gymId,
        memberId: old.id,
        planId: plan.id,
        startDate: addDays(new Date(), -200),
        expiryDate: addDays(new Date(), -170),
        pricePaid: 9999,
        status: 'expired',
      },
    });

    const c = (await dashboard(owner.cookie)).body.revenue.collection;
    expect(c.pending).toBe(1);
    expect(c.shortfall).toBe(1000);
  });

  it('withholds the whole figure from staff', async () => {
    const owner = await makeGym();
    const staff = await addUser(owner.gymId, { role: 'staff' });
    const member = await addMember(owner.gymId);
    await sellThisMonth(owner.gymId, member.id, { price: 2000 });

    const res = await dashboard(staff.cookie);

    // The revenue key is omitted entirely for staff, so there is no collection
    // figure to leak — not a zeroed one, which would be a wrong number they
    // are not allowed to have anyway.
    expect(res.status).toBe(200);
    expect(res.body.revenue).toBeUndefined();
  });

  it('reports zeroes for a gym with no memberships this month', async () => {
    const owner = await makeGym();
    const c = (await dashboard(owner.cookie)).body.revenue.collection;
    expect(c).toMatchObject({
      settled: 0, pending: 0, collected: 0, shortfall: 0, expected: 0,
    });
  });

  it('never counts another gym\'s memberships', async () => {
    const mine = await makeGym();
    const theirs = await makeGym({ gymName: 'Other' });

    const myMember = await addMember(mine.gymId);
    const theirMember = await addMember(theirs.gymId);

    await sellThisMonth(mine.gymId, myMember.id, { price: 1000 });
    await sellThisMonth(theirs.gymId, theirMember.id, { price: 8000 });

    const c = (await dashboard(mine.cookie)).body.revenue.collection;
    expect(c.expected).toBe(1000);
    expect(c.pending).toBe(1);
  });
});
