import { beforeEach, describe, expect, it } from 'vitest';

import prisma from '../../src/db.js';
import { addMember, addPlan, addUser, api, makeGym, resetDb } from '../helpers.js';

/**
 * The monthly collection report: who paid in a given month.
 *
 * The summary endpoint already proves the month's totals add up. What is worth
 * proving here is the part that is new — that the money is attributed to the
 * right people, that paid and due stay apart, and that a month means the month
 * the gym would name rather than a UTC window that borrows from its neighbours.
 */

beforeEach(resetDb);

/** A payment on a specific local date, which is what the month window is cut
 *  on. Built from parts rather than an ISO string so the date is not shifted
 *  into a neighbouring day by the runner's timezone. */
const pay = async (
  gymId: string,
  memberId: string,
  opts: {
    amount: number;
    year: number;
    month: number;
    day: number;
    hour?: number;
    status?: 'paid' | 'due';
    type?: 'membership' | 'supplement' | 'other';
  },
) => {
  const { amount, year, month, day, hour = 12, status = 'paid', type = 'membership' } = opts;
  return prisma.payment.create({
    data: {
      gymId,
      memberId,
      amount,
      status,
      type,
      paymentDate: new Date(year, month - 1, day, hour, 0, 0, 0),
    },
    select: { id: true },
  });
};

const get = (cookie: string, query: string) =>
  api().get(`/api/payments/monthly${query}`).set('Cookie', cookie);

describe('monthly collection — who paid, not just how much', () => {
  it('folds a member\'s several payments into one row', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId, { name: 'Ali' });

    await pay(owner.gymId, member.id, { amount: 1500, year: 2026, month: 8, day: 3 });
    await pay(owner.gymId, member.id, { amount: 1000, year: 2026, month: 8, day: 20 });

    const res = await get(owner.cookie, '?month=2026-08');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    // Two instalments are one member who paid 2500, not two who paid separately.
    expect(res.body.data[0]).toMatchObject({ name: 'Ali', paid: 2500, count: 2 });
    expect(res.body.memberCount).toBe(1);
    expect(res.body.paymentCount).toBe(2);
  });

  it('keeps money owed apart from money received', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    await pay(owner.gymId, member.id, { amount: 2000, year: 2026, month: 8, day: 5 });
    await pay(owner.gymId, member.id, {
      amount: 800, year: 2026, month: 8, day: 6, status: 'due',
    });

    const res = await get(owner.cookie, '?month=2026-08');

    // The one thing this report must never do is add these two together.
    expect(res.body.collected).toBe(2000);
    expect(res.body.outstanding).toBe(800);
    expect(res.body.data[0]).toMatchObject({ paid: 2000, due: 800 });
  });

  it('leaves a neighbouring month\'s payments out', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    await pay(owner.gymId, member.id, { amount: 500, year: 2026, month: 7, day: 31, hour: 23 });
    await pay(owner.gymId, member.id, { amount: 700, year: 2026, month: 8, day: 1, hour: 0 });
    await pay(owner.gymId, member.id, { amount: 900, year: 2026, month: 9, day: 1, hour: 0 });

    const res = await get(owner.cookie, '?month=2026-08');

    // A late-evening payment on the 31st belongs to July, and a midnight one
    // on the 1st to August — the boundary the gym would draw.
    expect(res.body.collected).toBe(700);
  });

  it('includes the last day of the month in full', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    // 23:59 on the 31st: an `lte` on the bare date would drop this entirely.
    await pay(owner.gymId, member.id, {
      amount: 1200, year: 2026, month: 8, day: 31, hour: 23,
    });

    const res = await get(owner.cookie, '?month=2026-08');
    expect(res.body.collected).toBe(1200);
  });

  it('handles February without losing its last day', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    await pay(owner.gymId, member.id, {
      amount: 300, year: 2026, month: 2, day: 28, hour: 20,
    });

    const res = await get(owner.cookie, '?month=2026-02');
    expect(res.body.collected).toBe(300);
  });

  it('ranks the biggest contributor first', async () => {
    const owner = await makeGym();
    const small = await addMember(owner.gymId, { name: 'Small' });
    const big = await addMember(owner.gymId, { name: 'Big' });

    await pay(owner.gymId, small.id, { amount: 500, year: 2026, month: 8, day: 4 });
    await pay(owner.gymId, big.id, { amount: 5000, year: 2026, month: 8, day: 4 });

    const res = await get(owner.cookie, '?month=2026-08');
    expect(res.body.data.map((r: { name: string }) => r.name)).toEqual(['Big', 'Small']);
  });

  it('searches by name, phone and member number', async () => {
    const owner = await makeGym();
    const ali = await addMember(owner.gymId, { name: 'Ali Raza', phone: '03001112222' });
    const usman = await addMember(owner.gymId, { name: 'Usman Khan', phone: '03009998888' });

    await pay(owner.gymId, ali.id, { amount: 1000, year: 2026, month: 8, day: 4 });
    await pay(owner.gymId, usman.id, { amount: 2000, year: 2026, month: 8, day: 4 });

    const byName = await get(owner.cookie, '?month=2026-08&search=ali');
    expect(byName.body.data).toHaveLength(1);
    expect(byName.body.data[0].name).toBe('Ali Raza');

    const byPhone = await get(owner.cookie, '?month=2026-08&search=9998888');
    expect(byPhone.body.data).toHaveLength(1);
    expect(byPhone.body.data[0].name).toBe('Usman Khan');

    // The totals have to follow the search, or the tiles would describe a
    // different set of rows than the table below them.
    expect(byName.body.collected).toBe(1000);
  });

  it('drops unpaid rows when asked to', async () => {
    const owner = await makeGym();
    const paid = await addMember(owner.gymId, { name: 'Paid' });
    const owing = await addMember(owner.gymId, { name: 'Owing' });

    await pay(owner.gymId, paid.id, { amount: 1000, year: 2026, month: 8, day: 4 });
    await pay(owner.gymId, owing.id, {
      amount: 900, year: 2026, month: 8, day: 4, status: 'due',
    });

    const res = await get(owner.cookie, '?month=2026-08&includeDue=false');

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Paid');
    expect(res.body.outstanding).toBe(0);
  });

  it('dates a row by its last settled payment, never an unpaid one', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    await pay(owner.gymId, member.id, { amount: 1000, year: 2026, month: 8, day: 10 });
    await pay(owner.gymId, member.id, {
      amount: 500, year: 2026, month: 8, day: 25, status: 'due',
    });

    const res = await get(owner.cookie, '?month=2026-08');
    // The 25th is an invoice, not a payment — "last paid" must still be the 10th.
    expect(new Date(res.body.data[0].lastPaymentAt).getDate()).toBe(10);
  });

  it('reports paisa exactly', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    await pay(owner.gymId, member.id, { amount: 1234.56, year: 2026, month: 8, day: 4 });
    await pay(owner.gymId, member.id, { amount: 0.44, year: 2026, month: 8, day: 5 });

    const res = await get(owner.cookie, '?month=2026-08');
    expect(res.body.collected).toBe(1235);
    expect(typeof res.body.data[0].paid).toBe('number');
  });
});

/**
 * A membership running between two local dates, with a price to be settled.
 * The unpaid list is driven by these rather than by payment rows, which is what
 * lets it see a member who has paid nothing at all.
 */
const sell = async (
  gymId: string,
  memberId: string,
  opts: {
    price: number;
    from: [number, number, number];
    to: [number, number, number];
    status?: 'active' | 'expired' | 'suspended' | 'cancelled' | 'superseded';
  },
) => {
  const { price, from, to, status = 'active' } = opts;
  const plan = await addPlan(gymId, { price });
  return prisma.membership.create({
    data: {
      gymId,
      memberId,
      planId: plan.id,
      startDate: new Date(from[0], from[1] - 1, from[2]),
      expiryDate: new Date(to[0], to[1] - 1, to[2], 23, 59, 59, 999),
      originalExpiryDate: new Date(to[0], to[1] - 1, to[2], 23, 59, 59, 999),
      pricePaid: price,
      status,
    },
    select: { id: true },
  });
};

/** A settled payment against a specific membership. */
const settle = (gymId: string, memberId: string, membershipId: string, amount: number,
  on: [number, number, number]) =>
  prisma.payment.create({
    data: {
      gymId, memberId, membershipId, amount, status: 'paid', type: 'membership',
      paymentDate: new Date(on[0], on[1] - 1, on[2], 12),
    },
    select: { id: true },
  });

describe('monthly collection — who has not paid', () => {
  it('lists a member who paid nothing at all', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId, { name: 'Bilal' });
    await sell(owner.gymId, member.id, {
      price: 3000, from: [2026, 8, 1], to: [2026, 8, 31],
    });

    const res = await get(owner.cookie, '?month=2026-08&view=unpaid');

    // The whole point: this member has no payment row, so a query over the
    // payments table could never have found them.
    expect(res.status).toBe(200);
    expect(res.body.unpaid).toHaveLength(1);
    expect(res.body.unpaid[0]).toMatchObject({
      name: 'Bilal', expected: 3000, paid: 0, shortfall: 3000,
    });
    expect(res.body.shortfallTotal).toBe(3000);
  });

  it('reports a part payment as the remainder, not the whole fee', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId, { name: 'Usman' });
    const ms = await sell(owner.gymId, member.id, {
      price: 2500, from: [2026, 8, 1], to: [2026, 8, 31],
    });
    await settle(owner.gymId, member.id, ms.id, 1500, [2026, 8, 10]);

    const res = await get(owner.cookie, '?month=2026-08&view=unpaid');
    expect(res.body.unpaid[0]).toMatchObject({ paid: 1500, shortfall: 1000 });
  });

  it('leaves out a member who has settled in full', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const ms = await sell(owner.gymId, member.id, {
      price: 2000, from: [2026, 8, 1], to: [2026, 8, 31],
    });
    await settle(owner.gymId, member.id, ms.id, 2000, [2026, 8, 5]);

    const res = await get(owner.cookie, '?month=2026-08&view=unpaid');
    expect(res.body.unpaid).toEqual([]);
    expect(res.body.shortfallTotal).toBe(0);
  });

  it('counts a fee paid early as settled', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const ms = await sell(owner.gymId, member.id, {
      price: 2000, from: [2026, 8, 1], to: [2026, 8, 31],
    });
    // Paid in late July for August. Dating the payment outside the window must
    // not turn a paid-up member into a defaulter.
    await settle(owner.gymId, member.id, ms.id, 2000, [2026, 7, 28]);

    const res = await get(owner.cookie, '?month=2026-08&view=unpaid');
    expect(res.body.unpaid).toEqual([]);
  });

  it('includes a member mid-way through a longer term', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId, { name: 'Quarterly' });
    // A three-month term that neither starts nor ends in August. Overlap is
    // what finds them; a "started in" or "expired in" test would not.
    await sell(owner.gymId, member.id, {
      price: 9000, from: [2026, 7, 1], to: [2026, 9, 30],
    });

    const res = await get(owner.cookie, '?month=2026-08&view=unpaid');
    expect(res.body.unpaid).toHaveLength(1);
    expect(res.body.unpaid[0].name).toBe('Quarterly');
  });

  it('leaves out memberships that never touched the month', async () => {
    const owner = await makeGym();
    const before = await addMember(owner.gymId, { name: 'Before' });
    const after = await addMember(owner.gymId, { name: 'After' });

    await sell(owner.gymId, before.id, {
      price: 1000, from: [2026, 6, 1], to: [2026, 7, 31],
    });
    await sell(owner.gymId, after.id, {
      price: 1000, from: [2026, 9, 1], to: [2026, 9, 30],
    });

    const res = await get(owner.cookie, '?month=2026-08&view=unpaid');
    expect(res.body.unpaid).toEqual([]);
  });

  it('does not chase a cancelled membership', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await sell(owner.gymId, member.id, {
      price: 5000, from: [2026, 8, 1], to: [2026, 8, 31], status: 'cancelled',
    });

    const res = await get(owner.cookie, '?month=2026-08&view=unpaid');
    // A term the gym agreed not to charge for is not a debt.
    expect(res.body.unpaid).toEqual([]);
  });

  it('does not bill a superseded term as well as the one that replaced it', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await sell(owner.gymId, member.id, {
      price: 2000, from: [2026, 8, 1], to: [2026, 8, 31], status: 'superseded',
    });
    await sell(owner.gymId, member.id, {
      price: 2500, from: [2026, 8, 15], to: [2026, 9, 14],
    });

    const res = await get(owner.cookie, '?month=2026-08&view=unpaid');
    // One live term, one debt — not both halves of an upgrade.
    expect(res.body.unpaid).toHaveLength(1);
    expect(res.body.unpaid[0].shortfall).toBe(2500);
  });

  it('ranks the biggest debt first', async () => {
    const owner = await makeGym();
    const small = await addMember(owner.gymId, { name: 'Small' });
    const big = await addMember(owner.gymId, { name: 'Big' });

    await sell(owner.gymId, small.id, { price: 500, from: [2026, 8, 1], to: [2026, 8, 31] });
    await sell(owner.gymId, big.id, { price: 7000, from: [2026, 8, 1], to: [2026, 8, 31] });

    const res = await get(owner.cookie, '?month=2026-08&view=unpaid');
    expect(res.body.unpaid.map((r: { name: string }) => r.name)).toEqual(['Big', 'Small']);
  });

  it('searches the unpaid list too', async () => {
    const owner = await makeGym();
    const ali = await addMember(owner.gymId, { name: 'Ali Raza' });
    const usman = await addMember(owner.gymId, { name: 'Usman Khan' });

    await sell(owner.gymId, ali.id, { price: 1000, from: [2026, 8, 1], to: [2026, 8, 31] });
    await sell(owner.gymId, usman.id, { price: 2000, from: [2026, 8, 1], to: [2026, 8, 31] });

    const res = await get(owner.cookie, '?month=2026-08&view=unpaid&search=ali');
    expect(res.body.unpaid).toHaveLength(1);
    expect(res.body.unpaid[0].name).toBe('Ali Raza');
    // The header total has to follow the search, like every other total here.
    expect(res.body.shortfallTotal).toBe(1000);
  });

  it('never reports another gym\'s debtors', async () => {
    const mine = await makeGym();
    const theirs = await makeGym({ gymName: 'Other Gym' });

    const myMember = await addMember(mine.gymId);
    const theirMember = await addMember(theirs.gymId);

    await sell(mine.gymId, myMember.id, { price: 1000, from: [2026, 8, 1], to: [2026, 8, 31] });
    await sell(theirs.gymId, theirMember.id, { price: 9999, from: [2026, 8, 1], to: [2026, 8, 31] });

    const res = await get(mine.cookie, '?month=2026-08&view=unpaid');
    expect(res.body.unpaid).toHaveLength(1);
    expect(res.body.shortfallTotal).toBe(1000);
  });

  it('refuses staff the unpaid view as well', async () => {
    const owner = await makeGym();
    const staff = await addUser(owner.gymId, { role: 'staff' });

    const res = await get(staff.cookie, '?month=2026-08&view=unpaid');
    expect(res.status).toBe(403);
  });

  it('serves both halves at once for the combined view', async () => {
    const owner = await makeGym();
    const payer = await addMember(owner.gymId, { name: 'Payer' });
    const debtor = await addMember(owner.gymId, { name: 'Debtor' });

    const ms = await sell(owner.gymId, payer.id, {
      price: 2000, from: [2026, 8, 1], to: [2026, 8, 31],
    });
    await settle(owner.gymId, payer.id, ms.id, 2000, [2026, 8, 5]);
    await sell(owner.gymId, debtor.id, { price: 3000, from: [2026, 8, 1], to: [2026, 8, 31] });

    const res = await get(owner.cookie, '?month=2026-08&view=all');

    expect(res.body.collected).toBe(2000);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Payer');
    expect(res.body.unpaid).toHaveLength(1);
    expect(res.body.unpaid[0].name).toBe('Debtor');
  });

  it('rejects a view it does not know', async () => {
    const owner = await makeGym();
    const res = await get(owner.cookie, '?month=2026-08&view=everyone');
    expect(res.status).toBe(400);
  });
});

describe('monthly collection — who may read it', () => {
  it('refuses staff', async () => {
    const owner = await makeGym();
    const staff = await addUser(owner.gymId, { role: 'staff' });

    const res = await get(staff.cookie, '?month=2026-08');
    expect(res.status).toBe(403);
  });

  it('refuses a signed-out caller', async () => {
    const res = await api().get('/api/payments/monthly?month=2026-08');
    expect(res.status).toBe(401);
  });

  it('never reports another gym\'s money', async () => {
    const mine = await makeGym();
    const theirs = await makeGym({ gymName: 'Other Gym' });

    const myMember = await addMember(mine.gymId);
    const theirMember = await addMember(theirs.gymId);

    await pay(mine.gymId, myMember.id, { amount: 1000, year: 2026, month: 8, day: 4 });
    await pay(theirs.gymId, theirMember.id, { amount: 9999, year: 2026, month: 8, day: 4 });

    const res = await get(mine.cookie, '?month=2026-08');
    expect(res.body.collected).toBe(1000);
    expect(res.body.memberCount).toBe(1);
  });
});

describe('monthly collection — the month has to be a month', () => {
  it('rejects a malformed month', async () => {
    const owner = await makeGym();
    for (const bad of ['2026', 'august', '2026-13', '2026-00', '2026-8-1']) {
      const res = await get(owner.cookie, `?month=${bad}`);
      expect(res.status, `expected ${bad} to be rejected`).toBe(400);
    }
  });

  it('requires a month at all', async () => {
    const owner = await makeGym();
    const res = await api().get('/api/payments/monthly').set('Cookie', owner.cookie);
    expect(res.status).toBe(400);
  });

  it('answers an empty month with zeroes rather than an error', async () => {
    const owner = await makeGym();
    const res = await get(owner.cookie, '?month=2026-08');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.collected).toBe(0);
    expect(res.body.memberCount).toBe(0);
  });
});
