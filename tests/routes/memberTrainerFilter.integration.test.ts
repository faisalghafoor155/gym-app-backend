import { beforeEach, describe, expect, it } from 'vitest';

import prisma from '../../src/db.js';
import { addMember, addMembership, api, makeGym, resetDb } from '../helpers.js';

/**
 * Narrowing the roster to one trainer's members.
 *
 * A filter, not a permission — the same rule the gender filter follows.
 * Two cases carry most of the weight: `none`, which asks for the members
 * nobody has been given and is the list a gym works through when handing them
 * out; and the tab counts, which have to narrow with the filter or a tab
 * reading 40 would land on 3.
 */

beforeEach(resetDb);

const names = (body: { data: { name: string }[] }): string[] =>
  body.data.map(m => m.name).sort();

const addTrainer = async (gymId: string, name: string): Promise<string> => {
  const trainer = await prisma.trainer.create({
    data: { gymId, name },
    select: { id: true },
  });
  return trainer.id;
};

/** A gym with two trainers, two members each, and one nobody has been given. */
const gymWithTrainers = async () => {
  const owner = await makeGym();
  const alpha = await addTrainer(owner.gymId, 'Coach Alpha');
  const beta = await addTrainer(owner.gymId, 'Coach Beta');

  const assign = async (name: string, phone: string, trainerId: string | null) => {
    const member = await addMember(owner.gymId, { name, phone });
    if (trainerId) {
      await prisma.member.update({ where: { id: member.id }, data: { trainerId } });
    }
    return member;
  };

  await assign('Alpha One', '03001111111', alpha);
  await assign('Alpha Two', '03002222222', alpha);
  await assign('Beta One', '03003333333', beta);
  await assign('Beta Two', '03004444444', beta);
  await assign('Unassigned Person', '03005555555', null);

  return { owner, alpha, beta };
};

describe('filtering the roster by trainer', () => {
  it('returns only that trainer\'s members', async () => {
    const { owner, alpha } = await gymWithTrainers();

    const res = await api().get('/api/members')
      .query({ trainerId: alpha }).set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual(['Alpha One', 'Alpha Two']);
    expect(res.body.total).toBe(2);
  });

  it('keeps two trainers\' lists apart', async () => {
    const { owner, beta } = await gymWithTrainers();

    const res = await api().get('/api/members')
      .query({ trainerId: beta }).set('Cookie', owner.cookie);

    expect(names(res.body)).toEqual(['Beta One', 'Beta Two']);
  });

  it('returns everyone when no trainer is asked for', async () => {
    const { owner } = await gymWithTrainers();

    const res = await api().get('/api/members').set('Cookie', owner.cookie);

    expect(res.body.total).toBe(5);
  });

  it('treats a blank trainer as no filter', async () => {
    const { owner } = await gymWithTrainers();

    const res = await api().get('/api/members')
      .query({ trainerId: '' }).set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
  });

  it('finds the members nobody has been given', async () => {
    const { owner } = await gymWithTrainers();

    const res = await api().get('/api/members')
      .query({ trainerId: 'none' }).set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    // Not the same as no filter: this is the list a gym works through when
    // handing members out, and there is no other way to ask for it.
    expect(names(res.body)).toEqual(['Unassigned Person']);
  });

  it('rejects a trainer id that is not one', async () => {
    const { owner } = await gymWithTrainers();

    const res = await api().get('/api/members')
      .query({ trainerId: 'not-a-uuid' }).set('Cookie', owner.cookie);

    expect(res.status).toBe(400);
  });

  it('returns nothing for a trainer with nobody on their list', async () => {
    const { owner } = await gymWithTrainers();
    const spare = await addTrainer(owner.gymId, 'Coach Spare');

    const res = await api().get('/api/members')
      .query({ trainerId: spare }).set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });
});

describe('how the trainer filter combines with the others', () => {
  it('narrows a search rather than replacing it', async () => {
    const { owner, alpha } = await gymWithTrainers();

    const res = await api().get('/api/members')
      .query({ trainerId: alpha, search: 'One' }).set('Cookie', owner.cookie);

    // 'Beta One' matches the search but not the trainer; 'Alpha Two' the
    // reverse. Only the member matching both survives.
    expect(names(res.body)).toEqual(['Alpha One']);
  });

  it('narrows the status tab counts too', async () => {
    const owner = await makeGym();
    const alpha = await addTrainer(owner.gymId, 'Coach Alpha');
    const beta = await addTrainer(owner.gymId, 'Coach Beta');

    const withMembership = async (name: string, phone: string, trainerId: string, days: number) => {
      const member = await addMember(owner.gymId, { name, phone });
      await prisma.member.update({ where: { id: member.id }, data: { trainerId } });
      await addMembership(owner.gymId, member.id, { expiresInDays: days });
    };

    await withMembership('Alpha Active', '03001111111', alpha, 40);
    await withMembership('Beta Active', '03002222222', beta, 40);
    await withMembership('Beta Also Active', '03003333333', beta, 40);

    const res = await api().get('/api/members')
      .query({ trainerId: alpha }).set('Cookie', owner.cookie);

    // A tab counting the whole gym while the list below showed one trainer's
    // members would make clicking a tab reading 3 land on 1.
    expect(res.body.counts.active).toBe(1);
    expect(res.body.counts.all).toBe(1);
  });

  it('combines with a status tab', async () => {
    const owner = await makeGym();
    const alpha = await addTrainer(owner.gymId, 'Coach Alpha');

    const withMembership = async (name: string, phone: string, days: number) => {
      const member = await addMember(owner.gymId, { name, phone });
      await prisma.member.update({ where: { id: member.id }, data: { trainerId: alpha } });
      await addMembership(owner.gymId, member.id, { expiresInDays: days });
    };

    await withMembership('Alpha Active', '03001111111', 40);
    await withMembership('Alpha Expired', '03002222222', -5);

    const res = await api().get('/api/members')
      .query({ trainerId: alpha, status: 'expired' }).set('Cookie', owner.cookie);

    expect(names(res.body)).toEqual(['Alpha Expired']);
  });

  it('applies to the unpaged list the pickers use', async () => {
    const { owner, alpha } = await gymWithTrainers();

    const res = await api().get('/api/members')
      .query({ trainerId: alpha, all: 'true' }).set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    // A filtered list that quietly went back to everyone on another shape of
    // the same endpoint would be worse than no filter.
    expect(names(res.body)).toEqual(['Alpha One', 'Alpha Two']);
  });

  it('holds across a page boundary', async () => {
    const owner = await makeGym();
    const alpha = await addTrainer(owner.gymId, 'Coach Alpha');
    const beta = await addTrainer(owner.gymId, 'Coach Beta');
    for (let i = 0; i < 4; i++) {
      const member = await addMember(owner.gymId, { name: `Alpha ${i}`, phone: `0300111000${i}` });
      await prisma.member.update({ where: { id: member.id }, data: { trainerId: alpha } });
    }
    for (let i = 0; i < 4; i++) {
      const member = await addMember(owner.gymId, { name: `Beta ${i}`, phone: `0300222000${i}` });
      await prisma.member.update({ where: { id: member.id }, data: { trainerId: beta } });
    }

    const page2 = await api().get('/api/members')
      .query({ trainerId: alpha, page: 2, limit: 2 }).set('Cookie', owner.cookie);

    expect(page2.body.total).toBe(4);
    expect(page2.body.hasMore).toBe(false);
    expect(page2.body.data.every((m: { name: string }) => m.name.startsWith('Alpha'))).toBe(true);
  });
});

describe('the trainer filter and other gyms', () => {
  it('never returns another gym\'s members', async () => {
    const { owner, alpha } = await gymWithTrainers();
    const other = await makeGym({ gymName: 'Rival Gym' });
    const theirTrainer = await addTrainer(other.gymId, 'Their Coach');
    const theirMember = await addMember(other.gymId, { name: 'Their Member' });
    await prisma.member.update({
      where: { id: theirMember.id },
      data: { trainerId: theirTrainer },
    });

    const mine = await api().get('/api/members')
      .query({ trainerId: alpha }).set('Cookie', owner.cookie);
    expect(names(mine.body)).toEqual(['Alpha One', 'Alpha Two']);

    // Aiming the filter straight at another gym's trainer must return nothing
    // rather than their roster — the gym scope is applied alongside it, not
    // replaced by it.
    const theirs = await api().get('/api/members')
      .query({ trainerId: theirTrainer }).set('Cookie', owner.cookie);
    expect(theirs.status).toBe(200);
    expect(theirs.body.data).toHaveLength(0);
  });

  it('does not leak another gym\'s unassigned members through none', async () => {
    const { owner } = await gymWithTrainers();
    const other = await makeGym({ gymName: 'Rival Gym' });
    await addMember(other.gymId, { name: 'Their Unassigned' });

    const res = await api().get('/api/members')
      .query({ trainerId: 'none' }).set('Cookie', owner.cookie);

    expect(names(res.body)).toEqual(['Unassigned Person']);
  });
});
