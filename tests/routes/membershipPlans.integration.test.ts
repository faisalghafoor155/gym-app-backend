import { beforeEach, describe, expect, it } from 'vitest';
import prisma from '../../src/db.js';
import { addPlan, addUser, api, makeGym, resetDb } from '../helpers.js';

/**
 * The price list.
 *
 * What a plan costs and how long it runs is the one table where a wrong edit
 * is money rather than tidiness — a year sold for a rupee is a year the gym
 * has to honour. Reading it is open to any staff, because selling a membership
 * means picking from this list at the desk; changing it is not.
 *
 * These cases exist because the endpoint had no permission guard at all: the
 * frontend hid the page and the API answered anybody who asked it directly.
 */
beforeEach(resetDb);

const staffWith = (gymId: string, staffPermission: 'manager' | 'members_manager' | 'accountant' | 'receptionist' | 'inventory_manager') =>
  addUser(gymId, { role: 'staff', staffPermission });

describe('membership plans — who may change the price list', () => {
  it('lets a manager create a plan', async () => {
    const owner = await makeGym();
    const manager = await staffWith(owner.gymId, 'manager');

    const res = await api().post('/api/membership-plans').set('Cookie', manager.cookie)
      .send({ name: 'Monthly', price: 2500, durationDays: 30 });

    expect(res.status).toBe(201);
  });

  it('lets a members manager create a plan, matching the page they can open', async () => {
    const owner = await makeGym();
    const mm = await staffWith(owner.gymId, 'members_manager');

    const res = await api().post('/api/membership-plans').set('Cookie', mm.cookie)
      .send({ name: 'Quarterly', price: 7000, durationDays: 90 });

    // The frontend guards /membership-plans with canManageMemberships, which
    // this level holds. If the server disagreed, the page would open and then
    // refuse to save — a worse failure than not showing it at all.
    expect(res.status).toBe(201);
  });

  it('refuses a receptionist trying to create a plan', async () => {
    const owner = await makeGym();
    const recep = await staffWith(owner.gymId, 'receptionist');

    const res = await api().post('/api/membership-plans').set('Cookie', recep.cookie)
      .send({ name: 'Year for nothing', price: 1, durationDays: 365 });

    expect(res.status).toBe(403);
    expect(await prisma.membershipPlan.count({ where: { gymId: owner.gymId } })).toBe(0);
  });

  it('refuses a receptionist trying to reprice an existing plan', async () => {
    const owner = await makeGym();
    const recep = await staffWith(owner.gymId, 'receptionist');
    const plan = await addPlan(owner.gymId, { price: 2500, durationDays: 30 });

    const res = await api().put(`/api/membership-plans/${plan.id}`)
      .set('Cookie', recep.cookie).send({ price: 1 });

    expect(res.status).toBe(403);
    const after = await prisma.membershipPlan.findUnique({
      where: { id: plan.id }, select: { price: true },
    });
    expect(after!.price.toNumber()).toBe(2500);
  });

  it('refuses a receptionist trying to retire a plan', async () => {
    const owner = await makeGym();
    const recep = await staffWith(owner.gymId, 'receptionist');
    const plan = await addPlan(owner.gymId);

    const res = await api().delete(`/api/membership-plans/${plan.id}`)
      .set('Cookie', recep.cookie);

    expect(res.status).toBe(403);
    const after = await prisma.membershipPlan.findUnique({
      where: { id: plan.id }, select: { isActive: true },
    });
    expect(after!.isActive).toBe(true);
  });

  it('still lets a receptionist read the list, which the desk needs to sell', async () => {
    const owner = await makeGym();
    const recep = await staffWith(owner.gymId, 'receptionist');
    await addPlan(owner.gymId, { name: 'Monthly' });

    const res = await api().get('/api/membership-plans').set('Cookie', recep.cookie);

    expect(res.status).toBe(200);
    const rows = res.body.data ?? res.body;
    expect(Array.isArray(rows) ? rows.length : 0).toBeGreaterThan(0);
  });
});
