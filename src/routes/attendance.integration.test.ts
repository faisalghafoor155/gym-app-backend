import { beforeEach, describe, expect, it } from 'vitest';

import prisma from '../db.js';
import { addMember, addMembership, addPlan, api, makeGym, resetDb } from '../test/helpers.js';

/**
 * Check-in, and the two things it has to get right beyond writing a row.
 *
 * A member may be checked in once a day, because attendance is the number the
 * gym reasons about and a double-press is indistinguishable from a second visit
 * once the rows are in. And nobody is turned away for an expired membership —
 * the standing travels back with the response instead, so the desk can act on
 * it while the member is still standing there.
 */

beforeEach(resetDb);

describe('POST /api/attendance/checkin — one per day', () => {
  it('records the first check-in of the day', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    const res = await api().post('/api/attendance/checkin')
      .set('Cookie', owner.cookie)
      .send({ memberId: member.id });

    expect(res.status).toBe(201);
    expect(res.body.alreadyCheckedIn).toBe(false);
    expect(await prisma.attendance.count()).toBe(1);
  });

  it('writes no second row when the button is pressed twice', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    const first = await api().post('/api/attendance/checkin')
      .set('Cookie', owner.cookie).send({ memberId: member.id });
    const second = await api().post('/api/attendance/checkin')
      .set('Cookie', owner.cookie).send({ memberId: member.id });

    // 200, not 201: nothing was created the second time.
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.alreadyCheckedIn).toBe(true);
    // The original row comes back, so the desk sees the real arrival time
    // rather than the moment somebody pressed the button again.
    expect(second.body.id).toBe(first.body.id);
    expect(await prisma.attendance.count()).toBe(1);
  });

  it('answers a duplicate as success rather than an error', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    await api().post('/api/attendance/checkin')
      .set('Cookie', owner.cookie).send({ memberId: member.id });
    const res = await api().post('/api/attendance/checkin')
      .set('Cookie', owner.cookie).send({ memberId: member.id });

    // The desk's intent — "this person is here" — is already satisfied. A red
    // toast for a double press trains staff to ignore red.
    expect(res.status).toBeLessThan(400);
  });

  it('holds even when both requests race past the check', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    // Fired together, so both can find no existing row before either insert
    // lands. Only the unique constraint decides this one.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        api().post('/api/attendance/checkin')
          .set('Cookie', owner.cookie).send({ memberId: member.id })),
    );

    expect(results.every(r => r.status < 400)).toBe(true);
    expect(await prisma.attendance.count()).toBe(1);
    // Exactly one request created it; the rest found it.
    expect(results.filter(r => r.status === 201)).toHaveLength(1);
  });

  it('lets the same member check in again the next day', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    await api().post('/api/attendance/checkin')
      .set('Cookie', owner.cookie).send({ memberId: member.id });
    // Backdated by a day: the constraint is per calendar day, not per 24 hours.
    await prisma.attendance.updateMany({
      where: { memberId: member.id },
      data: { checkedInAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });

    const res = await api().post('/api/attendance/checkin')
      .set('Cookie', owner.cookie).send({ memberId: member.id });

    expect(res.status).toBe(201);
    expect(await prisma.attendance.count()).toBe(2);
  });

  it('keeps two members on the same day apart', async () => {
    const owner = await makeGym();
    const one = await addMember(owner.gymId, { name: 'One' });
    const two = await addMember(owner.gymId, { name: 'Two' });

    await api().post('/api/attendance/checkin')
      .set('Cookie', owner.cookie).send({ memberId: one.id });
    const res = await api().post('/api/attendance/checkin')
      .set('Cookie', owner.cookie).send({ memberId: two.id });

    expect(res.status).toBe(201);
    expect(await prisma.attendance.count()).toBe(2);
  });
});

describe('POST /api/attendance/checkin — membership standing', () => {
  it('lets an expired member in, and says so', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await addMembership(owner.gymId, member.id, { expiresInDays: -12 });

    const res = await api().post('/api/attendance/checkin')
      .set('Cookie', owner.cookie).send({ memberId: member.id });

    // Nothing else in the app locks an expired member out — the dashboard
    // files them under people to phone — and somebody at the desk with cash in
    // hand is exactly who the gym wants inside.
    expect(res.status).toBe(201);
    expect(res.body.membership.status).toBe('expired');
    expect(res.body.membership.daysLeft).toBe(-12);
    expect(await prisma.attendance.count()).toBe(1);
  });

  it('flags a membership that is about to run out', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await addMembership(owner.gymId, member.id, { expiresInDays: 3 });

    const res = await api().post('/api/attendance/checkin')
      .set('Cookie', owner.cookie).send({ memberId: member.id });

    expect(res.body.membership.status).toBe('expiring');
    expect(res.body.membership.daysLeft).toBe(3);
  });

  it('says nothing alarming about a healthy membership', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await addMembership(owner.gymId, member.id, { expiresInDays: 30 });

    const res = await api().post('/api/attendance/checkin')
      .set('Cookie', owner.cookie).send({ memberId: member.id });

    expect(res.body.membership.status).toBe('active');
    expect(res.body.membership.planName).toBe('Monthly');
  });

  it('reports null for a member who was never sold anything', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    const res = await api().post('/api/attendance/checkin')
      .set('Cookie', owner.cookie).send({ memberId: member.id });

    expect(res.status).toBe(201);
    expect(res.body.membership).toBeNull();
  });

  it('ignores a superseded membership in favour of the current one', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const plan = await addPlan(owner.gymId);
    // An old membership that was replaced, and the renewal that replaced it.
    await addMembership(owner.gymId, member.id, {
      planId: plan.id, expiresInDays: -40, status: 'superseded',
    });
    await addMembership(owner.gymId, member.id, {
      planId: plan.id, expiresInDays: 25,
    });

    const res = await api().post('/api/attendance/checkin')
      .set('Cookie', owner.cookie).send({ memberId: member.id });

    // Reading the superseded row would tell the desk a renewed member is
    // expired, which is the one thing worse than saying nothing.
    expect(res.body.membership.status).toBe('active');
    expect(res.body.membership.daysLeft).toBe(25);
  });

  it('still reports the standing on a duplicate press', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await addMembership(owner.gymId, member.id, { expiresInDays: -5 });

    await api().post('/api/attendance/checkin')
      .set('Cookie', owner.cookie).send({ memberId: member.id });
    const res = await api().post('/api/attendance/checkin')
      .set('Cookie', owner.cookie).send({ memberId: member.id });

    // The warning is worth as much on the second press as the first — more, if
    // the first was somebody else's and this receptionist never saw it.
    expect(res.body.alreadyCheckedIn).toBe(true);
    expect(res.body.membership.status).toBe('expired');
  });
});

describe('POST /api/attendance/checkin — scoping', () => {
  it('will not check in another gym\'s member', async () => {
    const a = await makeGym({ gymName: 'A' });
    const b = await makeGym({ gymName: 'B' });
    const theirs = await addMember(b.gymId);

    const res = await api().post('/api/attendance/checkin')
      .set('Cookie', a.cookie).send({ memberId: theirs.id });

    expect(res.status).toBe(404);
    expect(await prisma.attendance.count()).toBe(0);
  });

  it('does not let one gym\'s check-in block another\'s', async () => {
    const a = await makeGym({ gymName: 'A' });
    const b = await makeGym({ gymName: 'B' });
    const mine = await addMember(a.gymId);
    const theirs = await addMember(b.gymId);

    const first = await api().post('/api/attendance/checkin')
      .set('Cookie', a.cookie).send({ memberId: mine.id });
    const second = await api().post('/api/attendance/checkin')
      .set('Cookie', b.cookie).send({ memberId: theirs.id });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });
});
