import { beforeEach, describe, expect, it } from 'vitest';

import prisma from '../../src/db.js';
import { addMember, addMembership, addUser, api, makeGym, resetDb } from '../helpers.js';

/**
 * Creating, reading, photographing and deleting a member.
 *
 * Searching, filtering and paging are covered at length elsewhere; what is
 * here is the rest of the lifecycle, and deleting most of all. Deleting a
 * member takes their payments with them, which moves the gym's books — so it
 * gets the closest attention, including what the audit trail keeps once the
 * rows themselves are gone.
 */

beforeEach(resetDb);

/** A 1x1 transparent GIF, small enough to sit inline. */
const tinyGif =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

describe('creating a member', () => {
  it('registers one and gives it the next number', async () => {
    const owner = await makeGym();

    const res = await api().post('/api/members').set('Cookie', owner.cookie)
      .send({ name: 'Ayesha Khan', phone: '03001234567' });

    expect(res.status).toBe(201);
    const created = res.body.member ?? res.body;
    expect(created.name).toBe('Ayesha Khan');
    expect(created.memberNo).toMatch(/^MEM-\d{5}$/);
    expect(created.status).toBe('active');
  });

  it('refuses a member with no name', async () => {
    const owner = await makeGym();

    const res = await api().post('/api/members').set('Cookie', owner.cookie)
      .send({ phone: '03001234567' });

    expect(res.status).toBe(400);
    expect(await prisma.member.count()).toBe(0);
  });

  it('refuses a blank name rather than storing whitespace', async () => {
    const owner = await makeGym();

    const res = await api().post('/api/members').set('Cookie', owner.cookie)
      .send({ name: '   ', phone: '03001234567' });

    expect(res.status).toBe(400);
    expect(await prisma.member.count()).toBe(0);
  });

  it('takes a joining fee when one was handed over', async () => {
    const owner = await makeGym();

    const res = await api().post('/api/members').set('Cookie', owner.cookie)
      .send({ name: 'Paid Up', phone: '03009998877', feeAmount: 1500, feeMethod: 'cash' });

    expect(res.status).toBe(201);
    const payment = await prisma.payment.findFirstOrThrow({ where: { gymId: owner.gymId } });
    expect(Number(payment.amount)).toBe(1500);
  });

  it('records no payment when no money changed hands', async () => {
    const owner = await makeGym();

    await api().post('/api/members').set('Cookie', owner.cookie)
      .send({ name: 'Bill Me Later', phone: '03009998866' });

    // A member can be registered now and billed from the Payments page later.
    expect(await prisma.payment.count()).toBe(0);
  });

  it('treats a zero fee as no receipt at all', async () => {
    const owner = await makeGym();

    const res = await api().post('/api/members').set('Cookie', owner.cookie)
      .send({ name: 'Nil Receipt', phone: '03009998855', feeAmount: 0, feeMethod: 'cash' });

    expect(res.status).toBeLessThan(500);
    expect(await prisma.payment.count()).toBe(0);
  });
});

describe('reading one member back', () => {
  it('returns the member with their current membership', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId, { name: 'Read Me' });
    await addMembership(owner.gymId, member.id, { expiresInDays: 15 });

    const res = await api().get(`/api/members/${member.id}`).set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    const body = res.body.member ?? res.body;
    expect(body.name).toBe('Read Me');
    expect(body.currentMembership).not.toBeNull();
    expect(body.currentMembership.daysLeft).toBe(15);
  });

  it('is a 404 for a member that does not exist', async () => {
    const owner = await makeGym();

    const res = await api()
      .get('/api/members/00000000-0000-4000-8000-000000000000')
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(404);
  });
});

describe('member photos', () => {
  it('stores a photo when there is nowhere else to put it', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    const res = await api().put(`/api/members/${member.id}`)
      .set('Cookie', owner.cookie).send({ photo: tinyGif });

    expect(res.status).toBe(200);
    // With no S3 configured the image falls back to the database, which is
    // what the test environment exercises.
    const after = await prisma.member.findUniqueOrThrow({ where: { id: member.id } });
    expect(after.photo).toBe(tinyGif);
  });

  it('removes a photo when it is set to nothing', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await api().put(`/api/members/${member.id}`).set('Cookie', owner.cookie).send({ photo: tinyGif });

    const res = await api().put(`/api/members/${member.id}`)
      .set('Cookie', owner.cookie).send({ photo: null });

    expect(res.status).toBe(200);
    const after = await prisma.member.findUniqueOrThrow({ where: { id: member.id } });
    expect(after.photo).toBeNull();
    expect(after.photoKey).toBeNull();
    expect(after.photoUrl).toBeNull();
  });

  it('leaves the photo alone when the field is not sent', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await api().put(`/api/members/${member.id}`).set('Cookie', owner.cookie).send({ photo: tinyGif });

    await api().put(`/api/members/${member.id}`).set('Cookie', owner.cookie).send({ name: 'Renamed' });

    // Not sent is not the same as cleared; editing a name must not wipe a face.
    const after = await prisma.member.findUniqueOrThrow({ where: { id: member.id } });
    expect(after.photo).toBe(tinyGif);
    expect(after.name).toBe('Renamed');
  });

  it('refuses anything that is not an image', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    // A data-URL that is not an image would otherwise be rendered straight
    // into an <img src>, which is how a script gets onto the page.
    const res = await api().put(`/api/members/${member.id}`).set('Cookie', owner.cookie)
      .send({ photo: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' });

    expect(res.status).toBe(400);
    const after = await prisma.member.findUniqueOrThrow({ where: { id: member.id } });
    expect(after.photo).toBeNull();
  });

  it('refuses a photo too large to store', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const huge = `data:image/png;base64,${'A'.repeat(4_000_001)}`;

    const res = await api().put(`/api/members/${member.id}`)
      .set('Cookie', owner.cookie).send({ photo: huge });

    expect(res.status).toBe(400);
  });
});

describe('deleting a member', () => {
  /** A member with something of everything hanging off them. */
  const memberWithHistory = async (gymId: string) => {
    const member = await addMember(gymId, { name: 'Leaving Member' });
    const membership = await addMembership(gymId, member.id, { expiresInDays: 10 });
    await prisma.payment.create({
      data: { gymId, memberId: member.id, membershipId: membership.id, amount: 2500, type: 'membership' },
    });
    await prisma.attendance.create({ data: { gymId, memberId: member.id } });
    return { member, membership };
  };

  it('takes their whole history with them', async () => {
    const owner = await makeGym();
    const { member } = await memberWithHistory(owner.gymId);

    const res = await api().delete(`/api/members/${member.id}`).set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    // Every relation is ON DELETE RESTRICT, so the children have to go first —
    // a partial delete would fail rather than orphan anything.
    expect(await prisma.member.count({ where: { id: member.id } })).toBe(0);
    expect(await prisma.membership.count({ where: { memberId: member.id } })).toBe(0);
    expect(await prisma.payment.count({ where: { memberId: member.id } })).toBe(0);
    expect(await prisma.attendance.count({ where: { memberId: member.id } })).toBe(0);
  });

  it('keeps a count of what went, in the only place left to keep it', async () => {
    const owner = await makeGym();
    const { member } = await memberWithHistory(owner.gymId);

    await api().delete(`/api/members/${member.id}`).set('Cookie', owner.cookie);

    const entry = await prisma.auditLog.findFirst({
      where: { gymId: owner.gymId, action: 'member.delete', entityId: member.id },
    });
    expect(entry).not.toBeNull();
    const before = entry?.before as { name?: string; deletedWith?: Record<string, number> };
    expect(before?.name).toBe('Leaving Member');
    // The rows are gone; how much history went with them is the part worth
    // knowing afterwards.
    expect(before?.deletedWith).toMatchObject({ payments: 1, memberships: 1, attendance: 1 });
  });

  it('takes the money out of the gym\'s takings with it', async () => {
    const owner = await makeGym();
    const { member } = await memberWithHistory(owner.gymId);
    const other = await addMember(owner.gymId, { name: 'Staying Member' });
    await prisma.payment.create({
      data: { gymId: owner.gymId, memberId: other.id, amount: 1000, type: 'membership' },
    });

    const before = await api().get('/api/payments').set('Cookie', owner.cookie);
    expect(before.body.collected).toBe(3500);

    await api().delete(`/api/members/${member.id}`).set('Cookie', owner.cookie);

    // Worth stating plainly: deleting a member is not a neutral act on the
    // books. Their 2500 leaves the collected figure with them.
    const after = await api().get('/api/payments').set('Cookie', owner.cookie);
    expect(after.body.collected).toBe(1000);
  });

  it('leaves everybody else untouched', async () => {
    const owner = await makeGym();
    const { member } = await memberWithHistory(owner.gymId);
    const survivor = await addMember(owner.gymId, { name: 'Survivor' });
    await addMembership(owner.gymId, survivor.id, { expiresInDays: 30 });

    await api().delete(`/api/members/${member.id}`).set('Cookie', owner.cookie);

    expect(await prisma.member.count({ where: { id: survivor.id } })).toBe(1);
    expect(await prisma.membership.count({ where: { memberId: survivor.id } })).toBe(1);
  });

  it('is a 404 for a member that does not exist', async () => {
    const owner = await makeGym();

    const res = await api()
      .delete('/api/members/00000000-0000-4000-8000-000000000000')
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(404);
  });

  it('refuses staff who may not manage members', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const staff = await addUser(owner.gymId, { role: 'staff' });

    const res = await api().delete(`/api/members/${member.id}`).set('Cookie', staff.cookie);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.member.count({ where: { id: member.id } })).toBe(1);
  });

  it('frees the member number rules for the next registration', async () => {
    const owner = await makeGym();
    const first = await api().post('/api/members').set('Cookie', owner.cookie)
      .send({ name: 'First', phone: '03001110001' });
    const firstNo = (first.body.member ?? first.body).memberNo;

    await api().delete(`/api/members/${(first.body.member ?? first.body).id}`)
      .set('Cookie', owner.cookie);

    const second = await api().post('/api/members').set('Cookie', owner.cookie)
      .send({ name: 'Second', phone: '03001110002' });

    // The counter does not rewind: a deleted member's number is not handed to
    // somebody else, or old receipts would start pointing at the wrong person.
    expect((second.body.member ?? second.body).memberNo).not.toBe(firstNo);
  });
});
