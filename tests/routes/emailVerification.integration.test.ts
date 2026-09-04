import { beforeEach, describe, expect, it } from 'vitest';

import prisma from '../../src/db.js';
import { api, makeGym, resetDb } from '../helpers.js';
import { issueEmailVerification } from '../../src/services/emailVerification.js';

/**
 * Confirming the address a gym signed up with.
 *
 * The point of this is not security — somebody who registers with a stranger's
 * address gets their own empty gym and none of anybody else's. It is the typo.
 * An owner who signed up as `faisal@gmial.com` has no working password reset,
 * and finds out on the day they are locked out.
 *
 * So the thing most worth protecting here is that it never becomes a gate.
 * Several of these check that an unverified account can still do its work,
 * because the moment this blocks anything it stops being a small helpful
 * nudge and becomes the reason a gym cannot open on its first morning — most
 * sharply in the deployments where no mail transport is configured at all and
 * the link only ever reaches the container log.
 */

beforeEach(resetDb);

/** Registers a new gym through the real endpoint, as a browser would. */
const register = (email: string) =>
  api()
    .post('/api/auth/register')
    .set('x-test-skip-ratelimit', '1')
    .send({
      gymName: 'Iron House',
      ownerName: 'Faisal',
      email,
      password: 'correct-horse-battery',
    });

/** Issues a token directly, since the mailed one never reaches the test. */
const tokenFor = async (userId: string): Promise<string> => {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true, name: true, gym: { select: { name: true } } },
  });
  const { link } = await issueEmailVerification(userId, {
    email: user.email,
    name: user.name,
    gymName: user.gym.name,
  });
  return new URL(link).searchParams.get('token')!;
};

describe('signing up', () => {
  it('signs the owner straight in, unverified', async () => {
    // The gym has to be usable immediately. Anything else would mean a gym
    // that cannot open on the morning it signs up.
    const res = await register('owner@example.com');

    expect(res.status).toBe(201);
    expect(res.headers['set-cookie']).toBeDefined();
    expect(res.body.user.emailVerified).toBe(false);
  });

  it('stores only the hash of the token', async () => {
    await register('owner@example.com');

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: 'owner@example.com' },
    });
    // A leaked database must not hand over live links.
    expect(user.verifyTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(user.emailVerifiedAt).toBeNull();
  });

  it('creates the gym even when the mail cannot be sent', async () => {
    // Mail is unconfigured in tests, which is exactly the case that must not
    // roll back a gym that has already been created.
    const res = await register('owner@example.com');

    expect(res.status).toBe(201);
    expect(await prisma.gym.count()).toBe(1);
  });
});

describe('confirming the address', () => {
  it('marks it verified and reports it on the session', async () => {
    const created = await register('owner@example.com');
    const cookie = created.headers['set-cookie'] as unknown as string[];
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: 'owner@example.com' },
    });

    const res = await api()
      .post('/api/auth/verify-email')
      .send({ token: await tokenFor(user.id) });

    expect(res.status).toBe(200);
    const me = await api().get('/api/auth/me').set('Cookie', cookie);
    expect(me.body.user.emailVerified).toBe(true);
  });

  it('works without being signed in', async () => {
    // The link is opened from an inbox, often on a device with no session.
    await register('owner@example.com');
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: 'owner@example.com' },
    });

    const res = await api()
      .post('/api/auth/verify-email')
      .send({ token: await tokenFor(user.id) });

    expect(res.status).toBe(200);
  });

  it('can only be used once', async () => {
    await register('owner@example.com');
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: 'owner@example.com' },
    });
    const token = await tokenFor(user.id);

    expect((await api().post('/api/auth/verify-email').send({ token })).status).toBe(200);
    expect((await api().post('/api/auth/verify-email').send({ token })).status).toBe(400);
  });

  it('refuses an unknown token', async () => {
    const res = await api()
      .post('/api/auth/verify-email')
      .send({ token: 'not-a-real-token' });

    expect(res.status).toBe(400);
  });

  it('refuses one that has expired', async () => {
    await register('owner@example.com');
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: 'owner@example.com' },
    });
    const token = await tokenFor(user.id);

    // 24 hours plus a minute.
    await prisma.user.update({
      where: { id: user.id },
      data: { verifyTokenAt: new Date(Date.now() - 24 * 60 * 60 * 1000 - 60_000) },
    });

    const res = await api().post('/api/auth/verify-email').send({ token });
    expect(res.status).toBe(400);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt,
    ).toBeNull();
  });

  it('invalidates the earlier link when a new one is sent', async () => {
    await register('owner@example.com');
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: 'owner@example.com' },
    });

    const first = await tokenFor(user.id);
    const second = await tokenFor(user.id);

    // "Send it again" should mean the old one stops working, or a link from an
    // old email stays live indefinitely.
    expect((await api().post('/api/auth/verify-email').send({ token: first })).status).toBe(400);
    expect((await api().post('/api/auth/verify-email').send({ token: second })).status).toBe(200);
  });
});

describe('resending', () => {
  it('needs a session', async () => {
    const res = await api().post('/api/auth/resend-verification');
    expect(res.status).toBe(401);
  });

  it('issues a fresh token', async () => {
    const created = await register('owner@example.com');
    const cookie = created.headers['set-cookie'] as unknown as string[];
    const before = await prisma.user.findUniqueOrThrow({
      where: { email: 'owner@example.com' },
    });

    const res = await api().post('/api/auth/resend-verification').set('Cookie', cookie);

    expect(res.status).toBe(200);
    // Reported rather than assumed, so a server with no mail configured says
    // so instead of leaving somebody waiting.
    expect(res.body.emailed).toBe(false);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.verifyTokenHash).not.toBe(before.verifyTokenHash);
  });

  it('refuses once the address is already confirmed', async () => {
    const created = await register('owner@example.com');
    const cookie = created.headers['set-cookie'] as unknown as string[];
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: 'owner@example.com' },
    });
    await api().post('/api/auth/verify-email').send({ token: await tokenFor(user.id) });

    const res = await api().post('/api/auth/resend-verification').set('Cookie', cookie);

    expect(res.status).toBe(400);
  });
});

describe('an unverified account is not restricted', () => {
  it('can still use the app', async () => {
    // The whole design rests on this. If it ever fails, the feature has turned
    // into a gate and a gym cannot open on the day it signs up.
    const created = await register('owner@example.com');
    const cookie = created.headers['set-cookie'] as unknown as string[];

    expect((await api().get('/api/members').set('Cookie', cookie)).status).toBe(200);
    expect((await api().get('/api/dashboard').set('Cookie', cookie)).status).toBe(200);
  });

  it('can still add a member', async () => {
    const created = await register('owner@example.com');
    const cookie = created.headers['set-cookie'] as unknown as string[];

    const res = await api()
      .post('/api/members')
      .set('Cookie', cookie)
      .send({ name: 'Ali Raza', joinDate: '2026-09-01', gender: 'male' });

    expect(res.status).toBe(201);
  });

  it('can still sign in', async () => {
    await register('owner@example.com');

    const res = await api()
      .post('/api/auth/login')
      .set('x-test-skip-ratelimit', '1')
      .send({ email: 'owner@example.com', password: 'correct-horse-battery' });

    expect(res.status).toBe(200);
    expect(res.body.user.emailVerified).toBe(false);
  });
});

describe('accounts created by invite', () => {
  it('are verified on arrival, without being asked again', async () => {
    // Following a link sent to that address proves what this proves. Asking a
    // second time would be theatre.
    const owner = await makeGym();
    const invited = await api()
      .post('/api/users/staff')
      .set('Cookie', owner.cookie)
      .send({ name: 'New Staff', email: 'staff@example.com' });
    expect(invited.status).toBe(201);

    // The link only comes back when no mail was sent, which is the case here:
    // no transport is configured in tests.
    const token = new URL(invited.body.invite.link as string).searchParams.get('token')!;
    const accepted = await api()
      .post('/api/auth/accept-invite')
      .set('x-test-skip-ratelimit', '1')
      .send({ token, password: 'correct-horse-battery' });

    expect(accepted.status).toBe(200);
    expect(accepted.body.user.emailVerified).toBe(true);
  });
});
