import { beforeEach, describe, expect, it } from 'vitest';
import prisma from '../../src/db.js';
import { addMember, addUser, api, makeGym, resetDb } from '../helpers.js';

beforeEach(resetDb);

describe('Plans API', () => {
  it('allows staff to create workout plans with valid structured data', async () => {
    const owner = await makeGym();

    // 1. Create a workout plan with valid workoutData
    const res = await api()
      .post('/api/plans/workout')
      .set('Cookie', owner.cookie)
      .send({
        name: 'Hypertrophy Plan',
        description: 'Building muscles',
        workoutData: {
          days: [
            {
              day: 'Monday',
              exercises: [
                {
                  name: 'Bench Press',
                  sets: 4,
                  reps: '8-12',
                  weight: '80kg',
                },
              ],
            },
          ],
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Hypertrophy Plan');
    expect(res.body.workoutData.days.length).toBe(1);
    expect(res.body.workoutData.days[0].exercises[0].name).toBe('Bench Press');
  });

  it('rejects workout plans with invalid structured data', async () => {
    const owner = await makeGym();

    // Reject missing name in exercises
    const res = await api()
      .post('/api/plans/workout')
      .set('Cookie', owner.cookie)
      .send({
        name: 'Invalid Plan',
        workoutData: {
          days: [
            {
              day: 'Monday',
              exercises: [
                {
                  sets: 4,
                  reps: '8-12',
                  weight: '80kg',
                },
              ],
            },
          ],
        },
      });

    expect(res.status).toBe(400);
  });

  it('allows staff to create diet plans with valid structured data', async () => {
    const owner = await makeGym();

    const res = await api()
      .post('/api/plans/diet')
      .set('Cookie', owner.cookie)
      .send({
        name: 'Bulk Diet',
        description: 'Eating a lot',
        dietData: {
          meals: [
            {
              name: 'Breakfast',
              items: [
                {
                  name: 'Eggs',
                  amount: '4 large',
                  calories: 280,
                },
              ],
            },
          ],
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Bulk Diet');
    expect(res.body.dietData.meals[0].items[0].name).toBe('Eggs');
  });
});

/**
 * Workout and diet plans.
 *
 * The frontend hides /plans behind `canManagePlans`; these cases exist because
 * the endpoints behind it did not check anything, so the page was hidden from
 * a receptionist while the API it called stayed open to one. Reading is
 * deliberately still open — a trainer or the desk may need to see what a member
 * was given.
 */
beforeEach(resetDb);

describe('workout and diet plans — who may write them', () => {
  it('lets a manager create a workout plan', async () => {
    const owner = await makeGym();
    const manager = await addUser(owner.gymId, { role: 'staff', staffPermission: 'manager' });

    const res = await api().post('/api/plans/workout').set('Cookie', manager.cookie)
      .send({ name: 'Push Pull Legs' });

    expect(res.status).toBe(201);
  });

  it('refuses a receptionist creating a workout plan', async () => {
    const owner = await makeGym();
    const recep = await addUser(owner.gymId, { role: 'staff', staffPermission: 'receptionist' });

    const res = await api().post('/api/plans/workout').set('Cookie', recep.cookie)
      .send({ name: 'Made without permission' });

    expect(res.status).toBe(403);
    expect(await prisma.workoutPlan.count({ where: { gymId: owner.gymId } })).toBe(0);
  });

  it('refuses a receptionist creating a diet plan', async () => {
    const owner = await makeGym();
    const recep = await addUser(owner.gymId, { role: 'staff', staffPermission: 'receptionist' });

    const res = await api().post('/api/plans/diet').set('Cookie', recep.cookie)
      .send({ name: 'Also without permission' });

    expect(res.status).toBe(403);
    expect(await prisma.dietPlan.count({ where: { gymId: owner.gymId } })).toBe(0);
  });

  it('refuses a receptionist assigning a plan to a member', async () => {
    const owner = await makeGym();
    const recep = await addUser(owner.gymId, { role: 'staff', staffPermission: 'receptionist' });
    const member = await addMember(owner.gymId);
    const created = await api().post('/api/plans/workout').set('Cookie', owner.cookie)
      .send({ name: 'Owner plan' });

    const res = await api().post('/api/plans/assign').set('Cookie', recep.cookie)
      .send({ memberId: member.id, workoutPlanId: created.body.id });

    expect(res.status).toBe(403);
  });

  it('still lets a receptionist read plans, which the desk may need', async () => {
    const owner = await makeGym();
    const recep = await addUser(owner.gymId, { role: 'staff', staffPermission: 'receptionist' });
    await api().post('/api/plans/workout').set('Cookie', owner.cookie).send({ name: 'Readable' });

    const res = await api().get('/api/plans/workout').set('Cookie', recep.cookie);

    expect(res.status).toBe(200);
  });
});
