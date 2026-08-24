import { beforeEach, describe, expect, it } from 'vitest';
import prisma from '../../src/db.js';
import { api, makeGym, resetDb } from '../helpers.js';

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
