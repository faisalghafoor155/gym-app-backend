import { beforeEach, describe, expect, it } from 'vitest';
import prisma from '../../src/db.js';
import { addMember, addPlan, addUser, api, makeGym, resetDb } from '../helpers.js';

/**
 * The personal-trainer fee used to be the literal `10000` written twice in the
 * member controller, so every gym charged the same price and none could change
 * it. These cases pin the replacement: a gym default, a per-trainer override,
 * and zero meaning "no charge" rather than "fall back to something".
 */

beforeEach(resetDb);

const addTrainer = (gymId: string, opts: { name?: string; ptFee?: number | null } = {}) =>
  prisma.trainer.create({
    data: {
      gymId,
      name: opts.name ?? 'Coach Bilal',
      ptFee: opts.ptFee === undefined ? null : opts.ptFee,
    },
    select: { id: true, name: true },
  });

const setFee = (gymId: string, defaultPtFee: number) =>
  prisma.gym.update({ where: { id: gymId }, data: { defaultPtFee } });

/** The trainer-fee charge raised for a member, if any. */
const feeCharge = async (memberId: string) =>
  prisma.payment.findFirst({ where: { memberId, type: 'other' } });

describe('Trainer fee — on registration', () => {
  it('charges the gym default when the trainer sets no price', async () => {
    const owner = await makeGym();
    await setFee(owner.gymId, 7500);
    const trainer = await addTrainer(owner.gymId);

    const res = await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'Ali Khan', phone: '03001234567', trainerId: trainer.id });

    expect(res.status).toBe(201);
    const charge = await feeCharge(res.body.id);
    expect(charge?.amount.toNumber()).toBe(7500);
    expect(charge?.status).toBe('due');
    expect(charge?.notes).toContain('Coach Bilal');
  });

  it('prefers the trainer\'s own price over the gym default', async () => {
    const owner = await makeGym();
    await setFee(owner.gymId, 7500);
    const trainer = await addTrainer(owner.gymId, { name: 'Coach Sara', ptFee: 12000 });

    const res = await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'Ali Khan', phone: '03001234567', trainerId: trainer.id });

    const charge = await feeCharge(res.body.id);
    expect(charge?.amount.toNumber()).toBe(12000);
  });

  it('raises no charge at all when the fee resolves to zero', async () => {
    const owner = await makeGym(); // defaultPtFee starts at 0
    const trainer = await addTrainer(owner.gymId);

    const res = await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'Ali Khan', phone: '03001234567', trainerId: trainer.id });

    // A zero-rupee "due" would sit on the member's outstanding list forever
    // and count as money the gym is owed.
    expect(await feeCharge(res.body.id)).toBeNull();
  });

  it('treats a trainer price of zero as free, not as "use the default"', async () => {
    const owner = await makeGym();
    await setFee(owner.gymId, 7500);
    const trainer = await addTrainer(owner.gymId, { ptFee: 0 });

    const res = await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'Ali Khan', phone: '03001234567', trainerId: trainer.id });

    expect(await feeCharge(res.body.id)).toBeNull();
  });

  it('raises nothing when no trainer is assigned', async () => {
    const owner = await makeGym();
    await setFee(owner.gymId, 7500);

    const res = await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'Ali Khan', phone: '03001234567' });

    expect(await feeCharge(res.body.id)).toBeNull();
  });

  it('ignores a trainer belonging to another gym', async () => {
    const owner = await makeGym();
    await setFee(owner.gymId, 7500);
    const other = await makeGym({ gymName: 'Rival Gym' });
    const theirTrainer = await addTrainer(other.gymId, { name: 'Their Coach' });

    const res = await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'Ali Khan', phone: '03001234567', trainerId: theirTrainer.id });

    // Whatever the member row ends up saying, no bill may carry another gym's
    // trainer name.
    const charge = await feeCharge(res.body.id ?? '');
    expect(charge).toBeNull();
  });
});

describe('Trainer fee — negotiated at the desk', () => {
  it('charges what the front desk typed, over both defaults', async () => {
    const owner = await makeGym();
    await setFee(owner.gymId, 10000);
    const trainer = await addTrainer(owner.gymId, { ptFee: 12000 });

    // The price list says 12,000; the member argued it down to 8,000.
    const res = await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'Ali Khan', phone: '03001234567', trainerId: trainer.id, ptFee: 8000 });

    expect(res.status).toBe(201);
    const charge = await feeCharge(res.body.id);
    expect(charge?.amount.toNumber()).toBe(8000);
    // The row says the price was agreed, so nobody has to wonder later why it
    // differs from the rate.
    expect(charge?.notes).toContain('agreed rate');
  });

  it('falls back to the defaults when the field is left blank', async () => {
    const owner = await makeGym();
    await setFee(owner.gymId, 10000);
    const trainer = await addTrainer(owner.gymId);

    for (const body of [
      { name: 'A', phone: '03001111111', trainerId: trainer.id },
      { name: 'B', phone: '03002222222', trainerId: trainer.id, ptFee: '' },
      { name: 'C', phone: '03003333333', trainerId: trainer.id, ptFee: null },
    ]) {
      const res = await api().post('/api/members').set('Cookie', owner.cookie).send(body);
      expect((await feeCharge(res.body.id))?.amount.toNumber(), body.name).toBe(10000);
    }
  });

  it('treats a typed 0 as a decision to charge nothing', async () => {
    const owner = await makeGym();
    await setFee(owner.gymId, 10000);
    const trainer = await addTrainer(owner.gymId);

    const res = await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'Ali Khan', phone: '03001234567', trainerId: trainer.id, ptFee: 0 });

    // Free, not "fall back to 10,000".
    expect(await feeCharge(res.body.id)).toBeNull();
  });

  it('does not mark a typed amount as agreed when it equals the rate', async () => {
    const owner = await makeGym();
    await setFee(owner.gymId, 10000);
    const trainer = await addTrainer(owner.gymId);

    const res = await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'Ali Khan', phone: '03001234567', trainerId: trainer.id, ptFee: 10000 });

    expect((await feeCharge(res.body.id))?.notes).not.toContain('agreed rate');
  });

  it('adds up: a 2500 plan and an 8000 trainer fee leave 10500 owed', async () => {
    const owner = await makeGym();
    await setFee(owner.gymId, 10000);
    const plan = await addPlan(owner.gymId, { price: 2500, durationDays: 30 });
    const trainer = await addTrainer(owner.gymId);

    const res = await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({
        name: 'Ali Khan',
        phone: '03001234567',
        planId: plan.id,
        trainerId: trainer.id,
        ptFee: 8000,
      });

    expect(res.status).toBe(201);
    const membership = await prisma.membership.findFirstOrThrow({
      where: { memberId: res.body.id },
    });
    expect(membership.pricePaid.toNumber()).toBe(2500);
    expect((await feeCharge(res.body.id))?.amount.toNumber()).toBe(8000);
  });

  it('ignores a fee sent without a trainer rather than rejecting it', async () => {
    const owner = await makeGym();
    // A form that keeps the field around while the trainer picker is empty is
    // not making an error worth a 400.
    const res = await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'Ali Khan', phone: '03001234567', ptFee: 8000 });

    expect(res.status).toBe(201);
    expect(await feeCharge(res.body.id)).toBeNull();
  });

  it('refuses a negative fee', async () => {
    const owner = await makeGym();
    const trainer = await addTrainer(owner.gymId);
    const res = await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'Ali Khan', phone: '03001234567', trainerId: trainer.id, ptFee: -500 });

    expect(res.status).toBe(400);
  });

  it('takes a negotiated fee when a trainer is hired later, from the edit form', async () => {
    const owner = await makeGym();
    await setFee(owner.gymId, 10000);
    const member = await addMember(owner.gymId);
    const trainer = await addTrainer(owner.gymId);

    const res = await api()
      .put(`/api/members/${member.id}`)
      .set('Cookie', owner.cookie)
      .send({ trainerId: trainer.id, ptFee: 7500 });

    expect(res.status).toBe(200);
    expect((await feeCharge(member.id))?.amount.toNumber()).toBe(7500);
  });

  it('takes a fresh negotiated fee when the member switches trainers', async () => {
    const owner = await makeGym();
    await setFee(owner.gymId, 10000);
    const member = await addMember(owner.gymId);
    const first = await addTrainer(owner.gymId, { name: 'Coach One' });
    const second = await addTrainer(owner.gymId, { name: 'Coach Two' });

    await api()
      .put(`/api/members/${member.id}`)
      .set('Cookie', owner.cookie)
      .send({ trainerId: first.id, ptFee: 6000 });
    await api()
      .put(`/api/members/${member.id}`)
      .set('Cookie', owner.cookie)
      .send({ trainerId: second.id, ptFee: 9000 });

    const charges = await prisma.payment.findMany({
      where: { memberId: member.id, type: 'other' },
      orderBy: { paymentDate: 'asc' },
    });
    expect(charges.map(c => c.amount.toNumber())).toEqual([6000, 9000]);
  });

  it('does not store the fee on the member row', async () => {
    const owner = await makeGym();
    const trainer = await addTrainer(owner.gymId);
    const res = await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'Ali Khan', phone: '03001234567', trainerId: trainer.id, ptFee: 8000 });

    // It prices one charge; it is not a property of the member.
    expect(res.body.ptFee).toBeUndefined();
  });
});

describe('Trainer fee — collected at the counter', () => {
  it('records a paid fee when the money was taken there and then', async () => {
    const owner = await makeGym();
    await setFee(owner.gymId, 10000);
    const trainer = await addTrainer(owner.gymId);

    const res = await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({
        name: 'Ali Khan',
        phone: '03001234567',
        trainerId: trainer.id,
        ptFee: 8000,
        ptFeePaid: true,
      });

    const charge = await feeCharge(res.body.id);
    expect(charge?.status).toBe('paid');
    expect(charge?.amount.toNumber()).toBe(8000);
    // Attributed, because somebody actually took it.
    expect(charge?.recordedById).toBe(owner.userId);
  });

  it('still defaults to a due when nothing is said', async () => {
    const owner = await makeGym();
    await setFee(owner.gymId, 10000);
    const trainer = await addTrainer(owner.gymId);

    const res = await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'Ali Khan', phone: '03001234567', trainerId: trainer.id });

    const charge = await feeCharge(res.body.id);
    // Claiming money arrived when it did not is the worse of the two errors.
    expect(charge?.status).toBe('due');
  });

  it('leaves a due unattributed — nobody has taken it yet', async () => {
    const owner = await makeGym();
    await setFee(owner.gymId, 10000);
    const trainer = await addTrainer(owner.gymId);

    const res = await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'Ali Khan', phone: '03001234567', trainerId: trainer.id, ptFeePaid: false });

    const charge = await feeCharge(res.body.id);
    expect(charge?.status).toBe('due');
    // Naming whoever typed the form would read as "this person took the money".
    expect(charge?.recordedById).toBeNull();
  });

  it('refuses a non-boolean rather than guessing at it', async () => {
    const owner = await makeGym();
    const trainer = await addTrainer(owner.gymId);

    // `z.coerce.boolean()` would read the string "false" as true and mark an
    // uncollected fee paid, so the schema is strict and this is a 400.
    const res = await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'Ali Khan', phone: '03001234567', trainerId: trainer.id, ptFeePaid: 'false' });

    expect(res.status).toBe(400);
  });

  it('counts a paid fee as revenue and a due one as outstanding', async () => {
    const owner = await makeGym();
    await setFee(owner.gymId, 10000);
    const paidTrainer = await addTrainer(owner.gymId, { name: 'Coach Paid' });
    const dueTrainer = await addTrainer(owner.gymId, { name: 'Coach Due' });

    await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'A', phone: '03001111111', trainerId: paidTrainer.id, ptFee: 8000, ptFeePaid: true });
    await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'B', phone: '03002222222', trainerId: dueTrainer.id, ptFee: 5000 });

    const profit = await api().get('/api/expenses/profit').set('Cookie', owner.cookie);
    // This is the whole point of the toggle: a fee taken at the counter must
    // not sit in the "money we are owed" column.
    expect(profit.body.revenue).toBe(8000);
    expect(profit.body.outstanding).toBe(5000);
  });

  it('takes a paid fee when a trainer is hired from the edit form', async () => {
    const owner = await makeGym();
    await setFee(owner.gymId, 10000);
    const member = await addMember(owner.gymId);
    const trainer = await addTrainer(owner.gymId);

    await api()
      .put(`/api/members/${member.id}`)
      .set('Cookie', owner.cookie)
      .send({ trainerId: trainer.id, ptFee: 7500, ptFeePaid: true });

    const charge = await feeCharge(member.id);
    expect(charge?.status).toBe('paid');
    expect(charge?.amount.toNumber()).toBe(7500);
  });

  it('raises nothing at all when a free assignment is marked paid', async () => {
    const owner = await makeGym();
    const trainer = await addTrainer(owner.gymId, { ptFee: 0 });

    const res = await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'Ali Khan', phone: '03001234567', trainerId: trainer.id, ptFeePaid: true });

    // A zero-rupee receipt is no more use than a zero-rupee debt.
    expect(await feeCharge(res.body.id)).toBeNull();
  });
});

describe('Trainer fee — on assignment via edit', () => {
  it('charges when a member moves onto a trainer', async () => {
    const owner = await makeGym();
    await setFee(owner.gymId, 5000);
    const member = await addMember(owner.gymId);
    const trainer = await addTrainer(owner.gymId);

    const res = await api()
      .put(`/api/members/${member.id}`)
      .set('Cookie', owner.cookie)
      .send({ trainerId: trainer.id });

    expect(res.status).toBe(200);
    expect((await feeCharge(member.id))?.amount.toNumber()).toBe(5000);
  });

  it('charges again when the member switches to a different trainer', async () => {
    const owner = await makeGym();
    await setFee(owner.gymId, 5000);
    const member = await addMember(owner.gymId);
    const first = await addTrainer(owner.gymId, { name: 'Coach One' });
    const second = await addTrainer(owner.gymId, { name: 'Coach Two', ptFee: 9000 });

    await api()
      .put(`/api/members/${member.id}`)
      .set('Cookie', owner.cookie)
      .send({ trainerId: first.id });
    await api()
      .put(`/api/members/${member.id}`)
      .set('Cookie', owner.cookie)
      .send({ trainerId: second.id });

    // A switch is a new engagement, so it bills — at the new trainer's price.
    const charges = await prisma.payment.findMany({
      where: { memberId: member.id, type: 'other' },
      orderBy: { paymentDate: 'asc' },
    });
    expect(charges).toHaveLength(2);
    expect(charges[1]!.amount.toNumber()).toBe(9000);
  });

  it('does not charge again when the same trainer is re-saved', async () => {
    const owner = await makeGym();
    await setFee(owner.gymId, 5000);
    const member = await addMember(owner.gymId);
    const trainer = await addTrainer(owner.gymId);

    await api()
      .put(`/api/members/${member.id}`)
      .set('Cookie', owner.cookie)
      .send({ trainerId: trainer.id });
    await api()
      .put(`/api/members/${member.id}`)
      .set('Cookie', owner.cookie)
      .send({ trainerId: trainer.id, name: 'Renamed Member' });

    expect(
      await prisma.payment.count({ where: { memberId: member.id, type: 'other' } }),
    ).toBe(1);
  });
});

describe('Gym settings', () => {
  it('lets the owner change the default fee, and it takes effect', async () => {
    const owner = await makeGym();
    const trainer = await addTrainer(owner.gymId);

    const put = await api()
      .put('/api/gym-settings')
      .set('Cookie', owner.cookie)
      .send({ defaultPtFee: 3000 });
    expect(put.status).toBe(200);
    expect(put.body.defaultPtFee).toBe(3000);

    const res = await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'Ali Khan', phone: '03001234567', trainerId: trainer.id });

    expect((await feeCharge(res.body.id))?.amount.toNumber()).toBe(3000);
  });

  it('returns the fee as a number, not a Decimal string', async () => {
    const owner = await makeGym();
    await setFee(owner.gymId, 1234.5);
    const res = await api().get('/api/gym-settings').set('Cookie', owner.cookie);
    expect(res.body.defaultPtFee).toBe(1234.5);
  });

  it('refuses a negative fee', async () => {
    const owner = await makeGym();
    const res = await api()
      .put('/api/gym-settings')
      .set('Cookie', owner.cookie)
      .send({ defaultPtFee: -1 });
    expect(res.status).toBe(400);
  });

  it('lets staff read the fee but not set it', async () => {
    const owner = await makeGym();
    const staff = await addUser(owner.gymId, { role: 'staff', staffPermission: 'manager' });

    expect((await api().get('/api/gym-settings').set('Cookie', staff.cookie)).status).toBe(200);

    const put = await api()
      .put('/api/gym-settings')
      .set('Cookie', staff.cookie)
      .send({ defaultPtFee: 999 });
    expect(put.status).toBe(403);
  });

  it('records a price change in the audit log', async () => {
    const owner = await makeGym();
    await api()
      .put('/api/gym-settings')
      .set('Cookie', owner.cookie)
      .send({ defaultPtFee: 4500 });

    const entry = await prisma.auditLog.findFirst({
      where: { gymId: owner.gymId, action: 'gym.settingsUpdate' },
    });
    expect(entry).toBeTruthy();
  });

  it('leaves no audit entry when the fee is saved unchanged', async () => {
    const owner = await makeGym();
    await setFee(owner.gymId, 4500);
    await api()
      .put('/api/gym-settings')
      .set('Cookie', owner.cookie)
      .send({ defaultPtFee: 4500 });

    expect(
      await prisma.auditLog.count({ where: { gymId: owner.gymId, action: 'gym.settingsUpdate' } }),
    ).toBe(0);
  });
});

describe('Trainer ptFee round-trip', () => {
  it('stores and returns a per-trainer price', async () => {
    const owner = await makeGym();
    const created = await api()
      .post('/api/trainers')
      .set('Cookie', owner.cookie)
      .send({ name: 'Coach Sara', commissionPercentage: 10, ptFee: 8000 });

    expect(created.status).toBe(201);
    expect(created.body.ptFee).toBe(8000);

    const list = await api().get('/api/trainers').set('Cookie', owner.cookie);
    expect(list.body.data[0].ptFee).toBe(8000);
  });

  it('defaults to null, meaning the gym price applies', async () => {
    const owner = await makeGym();
    const created = await api()
      .post('/api/trainers')
      .set('Cookie', owner.cookie)
      .send({ name: 'Coach Bilal', commissionPercentage: 10 });

    expect(created.body.ptFee).toBeNull();
  });

  it('can be cleared back to the gym default', async () => {
    const owner = await makeGym();
    const created = await api()
      .post('/api/trainers')
      .set('Cookie', owner.cookie)
      .send({ name: 'Coach Sara', commissionPercentage: 10, ptFee: 8000 });

    const updated = await api()
      .put(`/api/trainers/${created.body.id}`)
      .set('Cookie', owner.cookie)
      .send({ ptFee: null });

    // null is written through, unlike undefined which leaves the field alone.
    expect(updated.body.ptFee).toBeNull();
  });
});
