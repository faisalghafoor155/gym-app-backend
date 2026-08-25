import { beforeEach, describe, expect, it } from 'vitest';

import prisma from '../../src/db.js';
import { addMember, addMembership, addPlan, addUser, api, makeGym, resetDb } from '../helpers.js';

/**
 * Pausing and calling off a membership.
 *
 * Both states already existed in the schema and were handled correctly
 * everywhere they were read — the dashboard, the due list, the expiry job —
 * but nothing could ever set them. These are the endpoints that can, and the
 * rules they enforce.
 *
 * Suspending deliberately does not move the expiry date. The days keep
 * running, which is the gym's call to make at the counter; a member owed the
 * time back gets it by renewing from a date the desk chooses, rather than by
 * the app quietly rewriting what they bought.
 */

beforeEach(resetDb);

const withMembership = async (
  opts: { status?: 'active' | 'suspended' | 'cancelled' | 'superseded'; expiresInDays?: number } = {},
) => {
  const owner = await makeGym();
  const member = await addMember(owner.gymId, { name: 'Paused Member' });
  const plan = await addPlan(owner.gymId);
  const membership = await addMembership(owner.gymId, member.id, {
    planId: plan.id,
    expiresInDays: opts.expiresInDays ?? 20,
    status: opts.status ?? 'active',
  });
  return { owner, member, plan, membership };
};

const url = (memberId: string, membershipId: string, verb: string) =>
  `/api/members/${memberId}/memberships/${membershipId}/${verb}`;

describe('suspending a membership', () => {
  it('pauses it without moving the expiry date', async () => {
    const { owner, member, membership } = await withMembership();
    const before = await prisma.membership.findUniqueOrThrow({ where: { id: membership.id } });

    const res = await api()
      .post(url(member.id, membership.id, 'suspend'))
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('suspended');

    const after = await prisma.membership.findUniqueOrThrow({ where: { id: membership.id } });
    expect(after.status).toBe('suspended');
    // The whole point of the simple rule: the clock does not stop.
    expect(after.expiryDate.toISOString()).toBe(before.expiryDate.toISOString());
  });

  it('refuses to suspend one that is already suspended', async () => {
    const { owner, member, membership } = await withMembership({ status: 'suspended' });

    const res = await api()
      .post(url(member.id, membership.id, 'suspend'))
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(400);
  });

  it('stops chasing the debt while paused, without writing it off', async () => {
    const { owner, member, membership } = await withMembership({ expiresInDays: -5 });

    const before = await api().get('/api/payments/due').set('Cookie', owner.cookie);
    expect((before.body as { membership: { id: string }; outstanding: number }[])
      .find(r => r.membership.id === membership.id)?.outstanding).toBe(2500);

    await api().post(url(member.id, membership.id, 'suspend')).set('Cookie', owner.cookie);

    // The due list reports on active memberships only, so a paused one drops
    // off it — the gym is not phoning somebody whose membership it has itself
    // put on hold.
    const after = await api().get('/api/payments/due').set('Cookie', owner.cookie);
    expect((after.body as { membership: { id: string } }[])
      .some(r => r.membership.id === membership.id)).toBe(false);

    // Dropping off that list is not the same as the debt being forgiven: the
    // membership still records what it cost, and resuming brings it back.
    const paused = await prisma.membership.findUniqueOrThrow({ where: { id: membership.id } });
    expect(Number(paused.pricePaid)).toBe(2500);

    await api().post(url(member.id, membership.id, 'resume')).set('Cookie', owner.cookie);
    const resumed = await api().get('/api/payments/due').set('Cookie', owner.cookie);
    expect((resumed.body as { membership: { id: string }; outstanding: number }[])
      .find(r => r.membership.id === membership.id)?.outstanding).toBe(2500);
  });

  it('writes an audit entry naming both states', async () => {
    const { owner, member, membership } = await withMembership();

    await api().post(url(member.id, membership.id, 'suspend')).set('Cookie', owner.cookie);

    const entry = await prisma.auditLog.findFirst({
      where: { gymId: owner.gymId, action: 'membership.suspend', entityId: membership.id },
    });
    expect(entry).not.toBeNull();
    expect((entry?.before as { status?: string })?.status).toBe('active');
    expect((entry?.after as { status?: string })?.status).toBe('suspended');
  });
});

describe('resuming a membership', () => {
  it('puts a suspended membership back into service', async () => {
    const { owner, member, membership } = await withMembership({ status: 'suspended' });

    const res = await api()
      .post(url(member.id, membership.id, 'resume'))
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    const after = await prisma.membership.findUniqueOrThrow({ where: { id: membership.id } });
    expect(after.status).toBe('active');
  });

  it('refuses to resume one that was never suspended', async () => {
    const { owner, member, membership } = await withMembership();

    const res = await api()
      .post(url(member.id, membership.id, 'resume'))
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(400);
    const after = await prisma.membership.findUniqueOrThrow({ where: { id: membership.id } });
    expect(after.status).toBe('active');
  });

  it('reads as expired rather than active when it lapsed while paused', async () => {
    // Suspended on the 20th of a month that ran out on the 15th: resuming
    // cannot pretend the days were not spent.
    const { owner, member, membership } = await withMembership({
      status: 'suspended',
      expiresInDays: -5,
    });

    const res = await api()
      .post(url(member.id, membership.id, 'resume'))
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    // The stored status is active again, but the derived view keys off the
    // date, which is in the past.
    expect(res.body.status).toBe('expired');
  });
});

describe('cancelling a membership', () => {
  it('calls it off', async () => {
    const { owner, member, membership } = await withMembership();

    const res = await api()
      .post(url(member.id, membership.id, 'cancel'))
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    const after = await prisma.membership.findUniqueOrThrow({ where: { id: membership.id } });
    expect(after.status).toBe('cancelled');
  });

  it('leaves the payments already taken exactly where they are', async () => {
    const { owner, member, membership } = await withMembership();
    await api().post('/api/payments').set('Cookie', owner.cookie).send({
      memberId: member.id,
      membershipId: membership.id,
      amount: 2500,
      type: 'membership',
    });

    await api().post(url(member.id, membership.id, 'cancel')).set('Cookie', owner.cookie);

    // The money was taken and the books have to keep saying so. Refunding is
    // a separate act, with its own endpoint and its own audit entry.
    const payments = await prisma.payment.findMany({ where: { memberId: member.id } });
    expect(payments).toHaveLength(1);
    expect(Number(payments[0].amount)).toBe(2500);
  });

  it('stops chasing the member for the money', async () => {
    const { owner, member, membership } = await withMembership({ expiresInDays: -5 });

    const before = await api().get('/api/payments/due').set('Cookie', owner.cookie);
    expect((before.body as { membership: { id: string } }[])
      .some(r => r.membership.id === membership.id)).toBe(true);

    await api().post(url(member.id, membership.id, 'cancel')).set('Cookie', owner.cookie);

    const after = await api().get('/api/payments/due').set('Cookie', owner.cookie);
    // A called-off membership is not a debt the gym is still collecting.
    expect((after.body as { membership: { id: string } }[])
      .some(r => r.membership.id === membership.id)).toBe(false);
  });

  it('can be suspended first and cancelled after', async () => {
    const { owner, member, membership } = await withMembership({ status: 'suspended' });

    const res = await api()
      .post(url(member.id, membership.id, 'cancel'))
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    const after = await prisma.membership.findUniqueOrThrow({ where: { id: membership.id } });
    expect(after.status).toBe('cancelled');
  });

  it('refuses to change one that is already cancelled', async () => {
    const { owner, member, membership } = await withMembership({ status: 'cancelled' });

    for (const verb of ['suspend', 'resume', 'cancel']) {
      const res = await api().post(url(member.id, membership.id, verb)).set('Cookie', owner.cookie);
      expect(res.status).toBe(400);
    }
  });

  it('refuses to change one a renewal has already replaced', async () => {
    const { owner, member, membership } = await withMembership({ status: 'superseded' });

    for (const verb of ['suspend', 'resume', 'cancel']) {
      const res = await api().post(url(member.id, membership.id, verb)).set('Cookie', owner.cookie);
      expect(res.status).toBe(400);
    }
  });

  it('cannot be renewed once cancelled', async () => {
    const { owner, member, membership, plan } = await withMembership();
    await api().post(url(member.id, membership.id, 'cancel')).set('Cookie', owner.cookie);

    const res = await api()
      .post(url(member.id, membership.id, 'renew'))
      .set('Cookie', owner.cookie)
      .send({ planId: plan.id, amount: 2500, method: 'cash' });

    expect(res.status).toBe(400);
  });
});

describe('who may change a membership, and whose', () => {
  it('will not touch another gym\'s membership', async () => {
    const { member, membership } = await withMembership();
    const other = await makeGym({ gymName: 'Rival Gym' });

    for (const verb of ['suspend', 'resume', 'cancel']) {
      const res = await api().post(url(member.id, membership.id, verb)).set('Cookie', other.cookie);
      // Missing, not forbidden: a valid id belonging to somebody else must not
      // confirm that it exists.
      expect(res.status).toBe(404);
    }

    const after = await prisma.membership.findUniqueOrThrow({ where: { id: membership.id } });
    expect(after.status).toBe('active');
  });

  it('refuses staff who may not manage memberships', async () => {
    const { owner, member, membership } = await withMembership();
    const staff = await addUser(owner.gymId, { role: 'staff' });

    const res = await api()
      .post(url(member.id, membership.id, 'suspend'))
      .set('Cookie', staff.cookie);

    expect(res.status).toBeGreaterThanOrEqual(400);
    const after = await prisma.membership.findUniqueOrThrow({ where: { id: membership.id } });
    expect(after.status).toBe('active');
  });

  it('refuses a membership id that belongs to a different member', async () => {
    const { owner, membership } = await withMembership();
    const someoneElse = await addMember(owner.gymId, { name: 'Other Member' });

    const res = await api()
      .post(url(someoneElse.id, membership.id, 'suspend'))
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(404);
  });
});

describe('what the rest of the app makes of a paused membership', () => {
  it('still lets the member check in, and says they are suspended', async () => {
    const { owner, member, membership } = await withMembership();
    await api().post(url(member.id, membership.id, 'suspend')).set('Cookie', owner.cookie);

    const res = await api().post('/api/attendance/checkin')
      .set('Cookie', owner.cookie).send({ memberId: member.id });

    // Check-in gates on nothing; the standing travels back so the desk can act
    // on it while the member is standing there.
    expect(res.status).toBe(201);
    expect(res.body.membership.status).toBe('suspended');
  });

  it('shows a cancelled member as having no membership at all', async () => {
    const { owner, member, membership } = await withMembership();
    await api().post(url(member.id, membership.id, 'cancel')).set('Cookie', owner.cookie);

    const res = await api().post('/api/attendance/checkin')
      .set('Cookie', owner.cookie).send({ memberId: member.id });

    expect(res.status).toBe(201);
    expect(res.body.membership).toBeNull();
  });

  it('keeps a cancelled membership in the member\'s history', async () => {
    const { owner, member, membership } = await withMembership();
    await api().post(url(member.id, membership.id, 'cancel')).set('Cookie', owner.cookie);

    const res = await api().get(`/api/members/${member.id}/memberships`).set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    const rows = (res.body.data ?? res.body) as { id: string; status: string }[];
    // History is the record of what was bought; calling it off does not erase
    // that it happened.
    expect(rows.some(r => r.id === membership.id)).toBe(true);
  });

  it('lets the member be sold a fresh membership afterwards', async () => {
    const { owner, member, membership, plan } = await withMembership();
    await api().post(url(member.id, membership.id, 'cancel')).set('Cookie', owner.cookie);

    const res = await api()
      .post(`/api/members/${member.id}/memberships`)
      .set('Cookie', owner.cookie)
      .send({ planId: plan.id });

    expect(res.status).toBe(201);
    // The cancelled row stays cancelled rather than being swept up as
    // superseded by the new sale.
    const old = await prisma.membership.findUniqueOrThrow({ where: { id: membership.id } });
    expect(old.status).toBe('cancelled');
  });
});
