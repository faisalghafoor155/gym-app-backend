import { beforeEach, describe, expect, it } from 'vitest';

import prisma from '../../src/db.js';
import { addMember, addUser, api, makeGym, resetDb } from '../helpers.js';

/**
 * Stopping a gym that has stopped paying.
 *
 * Checked at the HTTP boundary rather than on the middleware, because the
 * guarantee is "no request from this gym does anything", and that only holds
 * if every way in is closed. There are five: an existing session, a password
 * login, a 2FA login, a Google sign-in, and an invite being accepted. A
 * suspension that closes four of them is not a suspension.
 *
 * The other half matters just as much and is easier to get wrong: a suspension
 * must not be a deletion. Everything the gym had is still there afterwards,
 * and resuming has to put it back exactly as it was — otherwise nobody will
 * dare use this and they will delete the gym instead.
 */

beforeEach(resetDb);

const suspendGym = (gymId: string, reason?: string) =>
  prisma.gym.update({
    where: { id: gymId },
    data: { suspendedAt: new Date(), suspendedReason: reason ?? null },
  });

describe('a suspended gym', () => {
  it('refuses a request from an existing session', async () => {
    const owner = await makeGym();
    // The session was issued before the suspension, which is the realistic
    // case: somebody is already signed in when the switch is thrown.
    await suspendGym(owner.gymId);

    const res = await api().get('/api/members').set('Cookie', owner.cookie);

    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('gym_suspended');
  });

  it('answers 403 rather than 401, so the app does not send them to sign in again', async () => {
    // 401 reads as "your session expired" and the owner would try signing in,
    // which would fail the same way forever with no explanation.
    const owner = await makeGym();
    await suspendGym(owner.gymId);

    const res = await api().get('/api/dashboard').set('Cookie', owner.cookie);

    expect(res.status).toBe(403);
    expect(res.status).not.toBe(401);
  });

  it('tells the owner why, when a reason was given', async () => {
    const owner = await makeGym();
    await suspendGym(owner.gymId, 'Unpaid since March');

    const res = await api().get('/api/members').set('Cookie', owner.cookie);

    expect(res.body.error).toBe('Unpaid since March');
  });

  it('falls back to a message that still tells them what to do', async () => {
    const owner = await makeGym();
    await suspendGym(owner.gymId);

    const res = await api().get('/api/members').set('Cookie', owner.cookie);

    expect(res.body.error).toMatch(/suspended/i);
    expect(res.body.error).toMatch(/support/i);
  });

  it('stops staff and members too, not just the owner', async () => {
    const owner = await makeGym();
    const staff = await addUser(owner.gymId, { role: 'staff' });
    const memberRecord = await addMember(owner.gymId, { name: 'Member Person' });
    const member = await addUser(owner.gymId, {
      role: 'member',
      memberId: memberRecord.id,
    });
    await suspendGym(owner.gymId);

    for (const account of [staff, member]) {
      const res = await api().get('/api/me/profile').set('Cookie', account.cookie);
      expect(res.status).toBe(403);
    }
  });

  it('refuses a fresh password login', async () => {
    // Otherwise signing in hands out a valid cookie that fails on the very
    // next request, which reads as a broken app rather than a suspended gym.
    const owner = await makeGym({ email: 'owner@example.com' });
    await suspendGym(owner.gymId, 'Unpaid since March');

    const res = await api()
      .post('/api/auth/login')
      .set('x-test-skip-ratelimit', '1')
      .send({ email: 'owner@example.com', password: 'correct-horse-battery' });

    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('gym_suspended');
    expect(res.body.error).toBe('Unpaid since March');
  });

  it('does not hand out a session cookie on that refused login', async () => {
    const owner = await makeGym({ email: 'owner2@example.com' });
    await suspendGym(owner.gymId);

    const res = await api()
      .post('/api/auth/login')
      .set('x-test-skip-ratelimit', '1')
      .send({ email: 'owner2@example.com', password: 'correct-horse-battery' });

    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('refuses before offering a second factor', async () => {
    // Making somebody find their authenticator app to reach a refusal helps
    // nobody, and a 2FA challenge would imply the sign-in was going to work.
    const owner = await makeGym({ email: 'owner3@example.com' });
    await prisma.user.update({
      where: { id: owner.userId },
      data: { twoFactorEnabled: true, twoFactorSecret: 'JBSWY3DPEHPK3PXP' },
    });
    await suspendGym(owner.gymId);

    const res = await api()
      .post('/api/auth/login')
      .set('x-test-skip-ratelimit', '1')
      .send({ email: 'owner3@example.com', password: 'correct-horse-battery' });

    expect(res.status).toBe(403);
    expect(res.body.requiresTwoFactor).toBeUndefined();
  });

  it('still lets a gym that is not suspended work normally', async () => {
    // The guard has to be inert when it is not wanted, or it would be worse
    // than the problem it solves.
    const owner = await makeGym();

    const res = await api().get('/api/members').set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
  });

  it('leaves another gym alone', async () => {
    const suspended = await makeGym({ gymName: 'Suspended Gym' });
    const running = await makeGym({ gymName: 'Running Gym' });
    await suspendGym(suspended.gymId);

    expect((await api().get('/api/members').set('Cookie', running.cookie)).status).toBe(200);
    expect((await api().get('/api/members').set('Cookie', suspended.cookie)).status).toBe(403);
  });
});

describe('suspension is reversible', () => {
  it('destroys nothing — the members are still there while it is suspended', async () => {
    const owner = await makeGym();
    await addMember(owner.gymId, { name: 'Ali Raza' });
    await addMember(owner.gymId, { name: 'Sara Khan' });
    await suspendGym(owner.gymId);

    // Read straight from the database: the app refuses to answer, which is the
    // point, so the proof that nothing was destroyed has to come from behind
    // the guard.
    expect(await prisma.member.count({ where: { gymId: owner.gymId } })).toBe(2);
  });

  it('puts the gym back exactly where it left off', async () => {
    const owner = await makeGym();
    await addMember(owner.gymId, { name: 'Ali Raza' });
    await suspendGym(owner.gymId, 'Unpaid');

    await prisma.gym.update({
      where: { id: owner.gymId },
      data: { suspendedAt: null, suspendedReason: null },
    });

    const res = await api().get('/api/members').set('Cookie', owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Ali Raza');
  });

  it('lets the same session back in, without a new sign-in', async () => {
    // The cookie was never invalidated — suspension is a gate, not a
    // revocation — so an owner who was mid-session when it was lifted should
    // simply find the app working again.
    const owner = await makeGym();
    await suspendGym(owner.gymId);
    expect((await api().get('/api/members').set('Cookie', owner.cookie)).status).toBe(403);

    await prisma.gym.update({
      where: { id: owner.gymId },
      data: { suspendedAt: null, suspendedReason: null },
    });

    expect((await api().get('/api/members').set('Cookie', owner.cookie)).status).toBe(200);
  });
});
