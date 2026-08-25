import { beforeEach, describe, expect, it } from 'vitest';

import prisma from '../../src/db.js';
import { addMember, addUser, api, makeGym, resetDb } from '../helpers.js';

/**
 * PT sessions, commission, and what the gym owes its trainers.
 *
 * Two sums live on a session and they are not the same money: what the member
 * pays the gym, and what the gym then owes the trainer out of it. They were
 * one column once, so taking a member's cash at the counter marked the
 * trainer's commission as already settled and the payouts page reported
 * nothing owed. Most of what is here exists to keep those two apart.
 */

beforeEach(resetDb);

const aTrainer = async (
  cookie: string,
  opts: { name?: string; commissionPercentage?: number } = {},
): Promise<string> => {
  const res = await api().post('/api/trainers').set('Cookie', cookie).send({
    name: opts.name ?? 'Coach',
    commissionPercentage: opts.commissionPercentage ?? 30,
  });
  return res.body.id ?? res.body.data?.id;
};

const aSession = (
  cookie: string,
  memberId: string,
  trainerId: string,
  over: Record<string, unknown> = {},
) =>
  api().post('/api/pt-sessions').set('Cookie', cookie).send({
    memberId,
    trainerId,
    sessionDate: new Date().toISOString(),
    priceCharged: 4000,
    status: 'completed',
    ...over,
  });

const payoutFor = async (cookie: string, trainerId: string) => {
  const res = await api().get('/api/payouts').set('Cookie', cookie);
  const rows = (res.body.data ?? res.body) as {
    trainerId: string; unpaidCommission: number; paidCommission: number; totalEarned: number;
  }[];
  return rows.find(r => r.trainerId === trainerId);
};

describe('what the member pays and what the trainer is owed', () => {
  it('still owes the trainer after the member has paid the gym', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const trainerId = await aTrainer(owner.cookie, { commissionPercentage: 30 });

    // The member hands over cash at the counter.
    await aSession(owner.cookie, member.id, trainerId, { paymentStatus: 'paid' });

    const row = await payoutFor(owner.cookie, trainerId);
    // The gym has the money; the trainer has not been given their share of it.
    // These were one column, and this read `paid: 1200, unpaid: 0`.
    expect(row?.unpaidCommission).toBe(1200);
    expect(row?.paidCommission).toBe(0);
  });

  it('owes the trainer even when the member has not paid yet', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const trainerId = await aTrainer(owner.cookie, { commissionPercentage: 25 });

    await aSession(owner.cookie, member.id, trainerId, { paymentStatus: 'unpaid' });

    // The trainer did the work either way; chasing the member is a separate
    // matter from settling with them.
    expect((await payoutFor(owner.cookie, trainerId))?.unpaidCommission).toBe(1000);
  });

  it('writes a payment when the member pays, and none when they do not', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const trainerId = await aTrainer(owner.cookie);

    await aSession(owner.cookie, member.id, trainerId, { paymentStatus: 'unpaid' });
    expect(await prisma.payment.count()).toBe(0);

    await aSession(owner.cookie, member.id, trainerId, { paymentStatus: 'paid' });
    const payment = await prisma.payment.findFirstOrThrow();
    expect(Number(payment.amount)).toBe(4000);
    expect(payment.status).toBe('paid');
  });

  it('does not let paying the trainer mark the member as having paid', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const trainerId = await aTrainer(owner.cookie);
    await aSession(owner.cookie, member.id, trainerId, { paymentStatus: 'unpaid' });

    await api().post(`/api/payouts/${trainerId}/pay`).set('Cookie', owner.cookie);

    // The other direction of the same confusion: settling with the trainer
    // says nothing about whether the member ever paid, and must not invent a
    // receipt for money the gym never took.
    const session = await prisma.ptSession.findFirstOrThrow();
    expect(session.paymentStatus).toBe('unpaid');
    expect(session.payoutStatus).toBe('paid');
    expect(await prisma.payment.count()).toBe(0);
  });
});

describe('commission', () => {
  it('takes the trainer\'s percentage of what was charged', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const trainerId = await aTrainer(owner.cookie, { commissionPercentage: 30 });

    await aSession(owner.cookie, member.id, trainerId, { priceCharged: 4000 });

    const session = await prisma.ptSession.findFirstOrThrow();
    expect(Number(session.trainerCommission)).toBe(1200);
  });

  it('treats a zero percentage as owing nothing, not as a default', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const trainerId = await aTrainer(owner.cookie, { commissionPercentage: 0 });

    await aSession(owner.cookie, member.id, trainerId);

    expect(Number((await prisma.ptSession.findFirstOrThrow()).trainerCommission)).toBe(0);
    expect((await payoutFor(owner.cookie, trainerId))?.unpaidCommission).toBe(0);
  });

  it('handles a trainer who keeps the whole fee', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const trainerId = await aTrainer(owner.cookie, { commissionPercentage: 100 });

    await aSession(owner.cookie, member.id, trainerId, { priceCharged: 3000 });

    expect(Number((await prisma.ptSession.findFirstOrThrow()).trainerCommission)).toBe(3000);
  });

  it('keeps what was agreed at the time, not what the rate is now', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const trainerId = await aTrainer(owner.cookie, { commissionPercentage: 30 });
    await aSession(owner.cookie, member.id, trainerId, { priceCharged: 4000 });

    await api().put(`/api/trainers/${trainerId}`).set('Cookie', owner.cookie)
      .send({ name: 'Coach', commissionPercentage: 50 });

    // Raising the rate cannot rewrite what a past session earned, the same
    // reason a membership snapshots its price.
    expect(Number((await prisma.ptSession.findFirstOrThrow()).trainerCommission)).toBe(1200);
  });

  it('rounds a fractional percentage to the paisa rather than drifting', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const trainerId = await aTrainer(owner.cookie, { commissionPercentage: 33.33 });

    await aSession(owner.cookie, member.id, trainerId, { priceCharged: 1000 });

    // 33.33% of 1000 is 333.29999999999995 in binary floating point.
    const session = await prisma.ptSession.findFirstOrThrow();
    expect(session.trainerCommission.toString()).toBe('333.3');
  });

  it('refuses a percentage above a hundred', async () => {
    const owner = await makeGym();

    const res = await api().post('/api/trainers').set('Cookie', owner.cookie)
      .send({ name: 'Greedy', commissionPercentage: 150 });

    expect(res.status).toBe(400);
  });

  it('refuses a negative percentage', async () => {
    const owner = await makeGym();

    const res = await api().post('/api/trainers').set('Cookie', owner.cookie)
      .send({ name: 'Odd', commissionPercentage: -10 });

    expect(res.status).toBe(400);
  });

  it('refuses a trainer with no name', async () => {
    const owner = await makeGym();

    const res = await api().post('/api/trainers').set('Cookie', owner.cookie)
      .send({ commissionPercentage: 20 });

    expect(res.status).toBe(400);
    expect(await prisma.trainer.count()).toBe(0);
  });
});

describe('paying a trainer out', () => {
  it('settles everything owed and reports how much', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const trainerId = await aTrainer(owner.cookie, { commissionPercentage: 30 });
    await aSession(owner.cookie, member.id, trainerId, { priceCharged: 4000 });
    await aSession(owner.cookie, member.id, trainerId, { priceCharged: 2000 });

    const res = await api().post(`/api/payouts/${trainerId}/pay`).set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    const row = await payoutFor(owner.cookie, trainerId);
    expect(row?.unpaidCommission).toBe(0);
    expect(row?.paidCommission).toBe(1800);
  });

  it('pays nothing twice', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const trainerId = await aTrainer(owner.cookie);
    await aSession(owner.cookie, member.id, trainerId);

    await api().post(`/api/payouts/${trainerId}/pay`).set('Cookie', owner.cookie);
    const second = await api().post(`/api/payouts/${trainerId}/pay`)
      .set('Cookie', owner.cookie);

    // Pressing the button again is not a second payment.
    expect(second.body.count).toBe(0);
    expect((await payoutFor(owner.cookie, trainerId))?.paidCommission).toBe(1200);
  });

  it('leaves a record of money going out', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const trainerId = await aTrainer(owner.cookie, { name: 'Coach Sara' });
    await aSession(owner.cookie, member.id, trainerId, { priceCharged: 4000 });

    await api().post(`/api/payouts/${trainerId}/pay`).set('Cookie', owner.cookie);

    // A payout was the one financial act in the app that left no trail.
    const entry = await prisma.auditLog.findFirst({
      where: { gymId: owner.gymId, action: 'trainer.payout' },
    });
    expect(entry).not.toBeNull();
    expect(entry?.entityLabel).toContain('Coach Sara');
    expect((entry?.after as { amount?: number })?.amount).toBe(1200);
    expect((entry?.after as { sessions?: number })?.sessions).toBe(1);
  });

  it('counts only sessions that actually happened', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const trainerId = await aTrainer(owner.cookie);
    await aSession(owner.cookie, member.id, trainerId, { status: 'scheduled' });
    await aSession(owner.cookie, member.id, trainerId, { status: 'cancelled' });

    // Nothing is owed for a session that has not been delivered.
    expect((await payoutFor(owner.cookie, trainerId))?.unpaidCommission).toBe(0);
    const res = await api().post(`/api/payouts/${trainerId}/pay`).set('Cookie', owner.cookie);
    expect(res.body.count).toBe(0);
  });

  it('will not pay another gym\'s trainer', async () => {
    const owner = await makeGym();
    const other = await makeGym({ gymName: 'Rival Gym' });
    const theirTrainer = await aTrainer(other.cookie);

    const res = await api().post(`/api/payouts/${theirTrainer}/pay`)
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(404);
  });

  it('refuses staff who may not move the gym\'s money', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const trainerId = await aTrainer(owner.cookie);
    await aSession(owner.cookie, member.id, trainerId);
    const staff = await addUser(owner.gymId, { role: 'staff' });

    const res = await api().post(`/api/payouts/${trainerId}/pay`).set('Cookie', staff.cookie);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await payoutFor(owner.cookie, trainerId))?.unpaidCommission).toBe(1200);
  });
});
