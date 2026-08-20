import { beforeEach, describe, expect, it } from 'vitest';

import prisma from '../../src/db.js';
import { addDays } from '../../src/services/membership.js';
import { addMember, addPlan, api, makeGym, resetDb } from '../helpers.js';

/**
 * The renewal a gym actually does: a member's month runs out, they pay again,
 * and the next month starts.
 *
 * This is the flow the whole app exists for, and it crosses four things that
 * are each tested apart but never together — the membership sale, the payment
 * that settles it, the superseding of the old term, and what the monthly
 * report says about the member afterwards. A break anywhere in that chain
 * shows up as the gym chasing somebody who has already paid.
 */

beforeEach(resetDb);

/** A member whose current membership expires `inDays` from now. Negative for
 *  one that has already run out. */
const memberDueForRenewal = async (
  gymId: string,
  opts: { inDays: number; price?: number; name?: string } = { inDays: 0 },
) => {
  const { inDays, price = 2500, name = 'Renewing Member' } = opts;
  const member = await addMember(gymId, { name });
  const plan = await addPlan(gymId, { price });
  const expiryDate = addDays(new Date(), inDays);

  const membership = await prisma.membership.create({
    data: {
      gymId,
      memberId: member.id,
      planId: plan.id,
      startDate: addDays(expiryDate, -plan.durationDays),
      expiryDate,
      pricePaid: price,
      status: 'active',
    },
    select: { id: true },
  });

  return { member, plan, membership };
};

describe('renewal — a member whose month is up pays again', () => {
  it('supersedes the old term and starts a new one', async () => {
    const owner = await makeGym();
    const { member, plan, membership } = await memberDueForRenewal(owner.gymId, { inDays: 0 });

    const res = await api().post(`/api/members/${member.id}/memberships`)
      .set('Cookie', owner.cookie)
      .send({ planId: plan.id });

    expect(res.status).toBe(201);

    const rows = await prisma.membership.findMany({
      where: { memberId: member.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, status: true },
    });

    // Both rows survive: the history of what this member bought is worth
    // keeping, and only one of them is live.
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.id === membership.id)?.status).toBe('superseded');
    expect(rows.find(r => r.id !== membership.id)?.status).toBe('active');
  });

  it('gives the new term a full duration from today, not from the old expiry', async () => {
    const owner = await makeGym();
    // A member who let it lapse a fortnight ago. Renewing must not hand them a
    // term that is already two weeks used up.
    const { member, plan } = await memberDueForRenewal(owner.gymId, { inDays: -14 });

    const res = await api().post(`/api/members/${member.id}/memberships`)
      .set('Cookie', owner.cookie)
      .send({ planId: plan.id });

    expect(res.status).toBe(201);
    expect(res.body.daysLeft).toBeGreaterThan(plan.durationDays - 2);
  });

  it('settles the new membership when the fee is recorded against it', async () => {
    const owner = await makeGym();
    const { member, plan } = await memberDueForRenewal(owner.gymId, { inDays: 0, price: 2500 });

    const sold = await api().post(`/api/members/${member.id}/memberships`)
      .set('Cookie', owner.cookie)
      .send({ planId: plan.id });

    const paid = await api().post('/api/payments')
      .set('Cookie', owner.cookie)
      .send({
        memberId: member.id,
        membershipId: sold.body.id,
        amount: 2500,
        type: 'membership',
      });

    expect(paid.status).toBe(201);
    expect(paid.body.membershipId).toBe(sold.body.id);
  });

  it('stops calling them a defaulter once they have renewed and paid', async () => {
    const owner = await makeGym();
    const { member, plan } = await memberDueForRenewal(owner.gymId, { inDays: 0, price: 2500 });

    const sold = await api().post(`/api/members/${member.id}/memberships`)
      .set('Cookie', owner.cookie)
      .send({ planId: plan.id });

    await api().post('/api/payments').set('Cookie', owner.cookie).send({
      memberId: member.id,
      membershipId: sold.body.id,
      amount: 2500,
      type: 'membership',
    });

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const unpaid = await api().get(`/api/payments/monthly?month=${month}&view=unpaid`)
      .set('Cookie', owner.cookie);

    // The heart of it: a member who has just paid must not appear on the list
    // of people to chase. The superseded old term must not be billed either.
    expect(unpaid.body.unpaid).toEqual([]);
  });

  it('still lists them when they renewed but have not paid yet', async () => {
    const owner = await makeGym();
    const { member, plan } = await memberDueForRenewal(owner.gymId, { inDays: 0, price: 2500 });

    await api().post(`/api/members/${member.id}/memberships`)
      .set('Cookie', owner.cookie)
      .send({ planId: plan.id });

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const unpaid = await api().get(`/api/payments/monthly?month=${month}&view=unpaid`)
      .set('Cookie', owner.cookie);

    // Sold but unsettled is exactly the case the unpaid list is for.
    expect(unpaid.body.unpaid).toHaveLength(1);
    expect(unpaid.body.unpaid[0]).toMatchObject({ shortfall: 2500, paid: 0 });
  });

  it('bills the renewal once, not the old term as well', async () => {
    const owner = await makeGym();
    const { member, plan } = await memberDueForRenewal(owner.gymId, { inDays: 0, price: 2500 });

    await api().post(`/api/members/${member.id}/memberships`)
      .set('Cookie', owner.cookie)
      .send({ planId: plan.id });

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const unpaid = await api().get(`/api/payments/monthly?month=${month}&view=unpaid`)
      .set('Cookie', owner.cookie);

    // One live term means one debt. Counting the superseded row too would ask
    // the member for double.
    expect(unpaid.body.shortfallTotal).toBe(2500);
  });

  it('shows the renewal in the month it was collected', async () => {
    const owner = await makeGym();
    const { member, plan } = await memberDueForRenewal(owner.gymId, { inDays: 0, price: 2500 });

    const sold = await api().post(`/api/members/${member.id}/memberships`)
      .set('Cookie', owner.cookie)
      .send({ planId: plan.id });

    await api().post('/api/payments').set('Cookie', owner.cookie).send({
      memberId: member.id,
      membershipId: sold.body.id,
      amount: 2500,
      type: 'membership',
    });

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const paidView = await api().get(`/api/payments/monthly?month=${month}&view=paid`)
      .set('Cookie', owner.cookie);

    expect(paidView.body.collected).toBe(2500);
    expect(paidView.body.data).toHaveLength(1);
    expect(paidView.body.data[0].paid).toBe(2500);
  });

  it('treats a part-paid renewal as owing the remainder', async () => {
    const owner = await makeGym();
    const { member, plan } = await memberDueForRenewal(owner.gymId, { inDays: 0, price: 2500 });

    const sold = await api().post(`/api/members/${member.id}/memberships`)
      .set('Cookie', owner.cookie)
      .send({ planId: plan.id });

    await api().post('/api/payments').set('Cookie', owner.cookie).send({
      memberId: member.id,
      membershipId: sold.body.id,
      amount: 1000,
      type: 'membership',
    });

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const unpaid = await api().get(`/api/payments/monthly?month=${month}&view=unpaid`)
      .set('Cookie', owner.cookie);

    expect(unpaid.body.unpaid[0]).toMatchObject({ paid: 1000, shortfall: 1500 });
  });

  it('reads as the member\'s current membership afterwards', async () => {
    const owner = await makeGym();
    const { member, plan } = await memberDueForRenewal(owner.gymId, { inDays: 0 });

    const sold = await api().post(`/api/members/${member.id}/memberships`)
      .set('Cookie', owner.cookie)
      .send({ planId: plan.id });

    const list = await api().get('/api/members').set('Cookie', owner.cookie);
    const row = (list.body.data as { id: string; currentMembership: { id: string; status: string } }[])
      .find(m => m.id === member.id);

    // The members page must show the new term, not the one it replaced.
    expect(row?.currentMembership.id).toBe(sold.body.id);
    expect(row?.currentMembership.status).toBe('active');
  });

  it('leaves a payment attached to the old term where it was', async () => {
    const owner = await makeGym();
    const { member, plan, membership } = await memberDueForRenewal(owner.gymId, { inDays: 0 });

    // Last month's fee, already settled against the term that is about to be
    // superseded.
    await api().post('/api/payments').set('Cookie', owner.cookie).send({
      memberId: member.id,
      membershipId: membership.id,
      amount: 2500,
      type: 'membership',
    });

    await api().post(`/api/members/${member.id}/memberships`)
      .set('Cookie', owner.cookie)
      .send({ planId: plan.id });

    const rows = await prisma.payment.findMany({
      where: { memberId: member.id },
      select: { membershipId: true },
    });

    // Renewing must not move history: that payment settled the old month, and
    // re-pointing it would make the old month look unpaid and the new one paid.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.membershipId).toBe(membership.id);
  });
});
