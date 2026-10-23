import { beforeEach, describe, expect, it } from 'vitest';
import prisma from '../../src/db.js';
import { addMember, addMembership, api, makeGym, resetDb } from '../helpers.js';

/**
 * Locker rent taken when a locker is handed over.
 *
 * The case worth pinning is the plan that already includes a locker: its
 * member has paid for the door once, in the plan price, and a fee typed at the
 * desk out of habit must not charge them for it twice.
 */
beforeEach(resetDb);

const setup = async (includesLocker: boolean) => {
  const owner = await makeGym();
  const plan = await prisma.membershipPlan.create({
    data: { gymId: owner.gymId, name: includesLocker ? 'Premium' : 'Basic', price: 5000, durationDays: 30, includesLocker },
  });
  const member = await addMember(owner.gymId);
  await addMembership(owner.gymId, member.id, { planId: plan.id });
  const locker = await prisma.locker.create({ data: { gymId: owner.gymId, number: '7' } });
  return { owner, member, locker };
};

describe('locker fees', () => {
  it('records the fee as a locker payment', async () => {
    const { owner, member, locker } = await setup(false);

    const res = await api().post(`/api/lockers/${locker.id}/assign`).set('Cookie', owner.cookie)
      .send({ memberId: member.id, feeAmount: 500, feeMethod: 'online', channel: 'jazzcash' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ coveredByPlan: false, feeRecorded: true });
    const payments = await prisma.payment.findMany({ where: { memberId: member.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ type: 'locker', method: 'online', channel: 'jazzcash', notes: 'Locker 7' });
    expect(payments[0]!.amount.toNumber()).toBe(500);
  });

  it('charges nothing when the plan includes a locker', async () => {
    const { owner, member, locker } = await setup(true);

    const res = await api().post(`/api/lockers/${locker.id}/assign`).set('Cookie', owner.cookie)
      .send({ memberId: member.id, feeAmount: 500, feeMethod: 'cash' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ coveredByPlan: true, feeRecorded: false });
    expect(await prisma.payment.count({ where: { memberId: member.id } })).toBe(0);
  });

  it('hands the locker over free when no fee is given', async () => {
    const { owner, member, locker } = await setup(false);

    const res = await api().post(`/api/lockers/${locker.id}/assign`).set('Cookie', owner.cookie)
      .send({ memberId: member.id });

    expect(res.status).toBe(200);
    expect(res.body.feeRecorded).toBe(false);
    expect(res.body.member.id).toBe(member.id);
    expect(await prisma.payment.count({ where: { memberId: member.id } })).toBe(0);
  });

  it('refuses a channel on a cash fee', async () => {
    const { owner, member, locker } = await setup(false);

    const res = await api().post(`/api/lockers/${locker.id}/assign`).set('Cookie', owner.cookie)
      .send({ memberId: member.id, feeAmount: 500, feeMethod: 'cash', channel: 'easypaisa' });

    expect(res.status).toBe(400);
    expect(await prisma.locker.findUnique({ where: { id: locker.id } })).toMatchObject({ memberId: null });
  });
});

describe('plan inclusions', () => {
  it('stores and returns what a plan covers', async () => {
    const owner = await makeGym();

    const res = await api().post('/api/membership-plans').set('Cookie', owner.cookie)
      .send({ name: 'Premium', price: 5000, durationDays: 30, includesCardio: true, includesLocker: true });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ includesCardio: true, includesLocker: true });

    const basic = await api().post('/api/membership-plans').set('Cookie', owner.cookie)
      .send({ name: 'Basic', price: 3000, durationDays: 30 });
    expect(basic.body).toMatchObject({ includesCardio: false, includesLocker: false });
  });
});
