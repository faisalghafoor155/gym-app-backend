import { beforeEach, describe, expect, it } from 'vitest';

import prisma from '../../src/db.js';
import { addMember, addUser, api, makeGym, resetDb } from '../helpers.js';

/**
 * Role boundaries: owner > staff > member.
 *
 * Checked at the HTTP boundary because that is where the guarantee actually
 * has to hold. A route that forgot its `requireOwner` still looks correct in
 * the controller.
 */

beforeEach(resetDb);

/** One gym holding all three kinds of account. */
const gymWithRoles = async () => {
  const owner = await makeGym({ gymName: 'Iron Works' });
  const staff = await addUser(owner.gymId, { role: 'staff' });
  const memberRecord = await addMember(owner.gymId, { name: 'Member Person' });
  const member = await addUser(owner.gymId, { role: 'member', memberId: memberRecord.id });
  return { owner, staff, member, memberRecord };
};

describe('owner-only routes', () => {
  it('lets an owner create a staff account', async () => {
    const { owner } = await gymWithRoles();

    const res = await api().post('/api/users/staff')
      .set('Cookie', owner.cookie)
      .send({ name: 'New Staff', email: 'new-staff@example.com' });

    expect(res.status).toBe(201);
    const created = await prisma.user.findUnique({ where: { email: 'new-staff@example.com' } });
    expect(created?.role).toBe('staff');
  });

  it('refuses staff trying to create another staff account', async () => {
    const { staff } = await gymWithRoles();

    const res = await api().post('/api/users/staff')
      .set('Cookie', staff.cookie)
      .send({ name: 'Escalated', email: 'escalated@example.com' });

    expect(res.status).toBe(403);
    expect(await prisma.user.findUnique({ where: { email: 'escalated@example.com' } })).toBeNull();
  });

  it('refuses a member trying to create a staff account', async () => {
    const { member } = await gymWithRoles();

    const res = await api().post('/api/users/staff')
      .set('Cookie', member.cookie)
      .send({ name: 'Escalated', email: 'escalated@example.com' });

    expect(res.status).toBe(403);
  });

  it('refuses staff trying to transfer ownership', async () => {
    const { staff, owner } = await gymWithRoles();

    const res = await api().post('/api/users/transfer-ownership')
      .set('Cookie', staff.cookie)
      .send({ userId: staff.userId });

    expect(res.status).toBe(403);
    const stillOwner = await prisma.user.findUnique({ where: { id: owner.userId } });
    expect(stillOwner?.role).toBe('owner');
  });

  it('refuses staff reading the audit log', async () => {
    const { staff } = await gymWithRoles();

    const res = await api().get('/api/audit-logs').set('Cookie', staff.cookie);

    expect(res.status).toBe(403);
  });

  it('does not let staff delete a user', async () => {
    const { staff, owner } = await gymWithRoles();

    const res = await api().delete(`/api/users/${owner.userId}`).set('Cookie', staff.cookie);

    expect(res.status).toBe(403);
    expect(await prisma.user.findUnique({ where: { id: owner.userId } })).not.toBeNull();
  });
});

describe('staff routes', () => {
  it('lets staff manage members', async () => {
    const { staff } = await gymWithRoles();

    const res = await api().post('/api/members')
      .set('Cookie', staff.cookie)
      .send({ name: 'Added By Staff', phone: '03001234567' });

    expect(res.status).toBe(201);
  });

  it.each([
    ['members', '/api/members'],
    ['attendance today', '/api/attendance/today'],
    ['payments', '/api/payments'],
    ['supplements', '/api/supplements'],
    ['the dashboard', '/api/dashboard'],
  ])('refuses a member reading %s', async (_label, path) => {
    const { member } = await gymWithRoles();

    const res = await api().get(path).set('Cookie', member.cookie);

    // A member sees their own data through /api/me, never the gym's roster.
    expect(res.status).toBe(403);
  });

  it('refuses a member checking anyone in', async () => {
    const { member, memberRecord } = await gymWithRoles();

    const res = await api().post('/api/attendance/checkin')
      .set('Cookie', member.cookie)
      .send({ memberId: memberRecord.id });

    // Not even themselves — attendance is something the front desk records.
    expect(res.status).toBe(403);
    expect(await prisma.attendance.count()).toBe(0);
  });

  it('refuses a member recording a payment', async () => {
    const { member, memberRecord } = await gymWithRoles();

    const res = await api().post('/api/payments')
      .set('Cookie', member.cookie)
      .send({ memberId: memberRecord.id, amount: 1, type: 'membership' });

    expect(res.status).toBe(403);
    expect(await prisma.payment.count()).toBe(0);
  });
});

describe('GET /api/me', () => {
  it('lets a member read their own record', async () => {
    const { member } = await gymWithRoles();

    const res = await api().get('/api/me').set('Cookie', member.cookie);

    expect(res.status).toBe(200);
  });

  it('returns the member their own record and nobody else\'s', async () => {
    const { owner, member, memberRecord } = await gymWithRoles();
    const other = await addMember(owner.gymId, { name: 'Someone Else' });

    const res = await api().get('/api/me').set('Cookie', member.cookie);

    const body = JSON.stringify(res.body);
    expect(body).toContain(memberRecord.name);
    expect(body).not.toContain(other.name);
  });
});

describe('role changes take effect immediately', () => {
  it('stops a demoted owner using owner-only routes', async () => {
    const { owner } = await gymWithRoles();
    const second = await addUser(owner.gymId, { role: 'owner' });

    await prisma.user.update({ where: { id: second.userId }, data: { role: 'staff' } });

    const res = await api().post('/api/users/staff')
      .set('Cookie', second.cookie)
      .send({ name: 'Nope', email: 'nope@example.com' });

    // The role is read from the database per request, so the demotion binds
    // on the very next call rather than when the token expires.
    expect(res.status).toBe(403);
  });

  it('lets a promoted staff account use owner-only routes', async () => {
    const { staff } = await gymWithRoles();
    await prisma.user.update({ where: { id: staff.userId }, data: { role: 'owner' } });

    const res = await api().post('/api/users/staff')
      .set('Cookie', staff.cookie)
      .send({ name: 'Now Allowed', email: 'now-allowed@example.com' });

    expect(res.status).toBe(201);
  });
});

describe('unauthenticated access', () => {
  it.each([
    '/api/members',
    '/api/payments',
    '/api/dashboard',
    '/api/users',
    '/api/audit-logs',
    '/api/me',
    '/api/supplements',
  ])('refuses GET %s with no session', async path => {
    const res = await api().get(path);

    expect(res.status).toBe(401);
  });

  it('leaves the health check open', async () => {
    const res = await api().get('/api/health');
    expect(res.status).toBe(200);
  });
});
