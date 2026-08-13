import { beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';

import prisma from '../../src/db.js';
import { api, addUser, cookieFor, makeGym, rawApi, resetDb } from '../helpers.js';

beforeEach(resetDb);

/** Pulls the session cookie's value out of a response's Set-Cookie header. */
const sessionCookie = (res: { headers: Record<string, unknown> }): string | undefined => {
  const raw = res.headers['set-cookie'] as string[] | undefined;
  return raw?.find(c => c.startsWith('gym_session='));
};

describe('POST /api/auth/register', () => {
  const body = {
    gymName: 'Iron Works',
    ownerName: 'Ayesha',
    email: 'ayesha@example.com',
    password: 'correct-horse-battery',
  };

  it('creates a gym whose first account is its owner', async () => {
    const res = await api().post('/api/auth/register').send(body);

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'ayesha@example.com', role: 'owner' });

    const user = await prisma.user.findUnique({ where: { email: 'ayesha@example.com' } });
    expect(user?.role).toBe('owner');
  });

  it('never returns the password hash', async () => {
    const res = await api().post('/api/auth/register').send(body);
    expect(JSON.stringify(res.body)).not.toContain('$2');
    expect(res.body.user?.passwordHash).toBeUndefined();
  });

  it('signs the new owner in immediately', async () => {
    const res = await api().post('/api/auth/register').send(body);
    const cookie = sessionCookie(res);
    expect(cookie).toBeDefined();
    expect(cookie).toContain('HttpOnly');
  });

  it('stores the password hashed, not in the clear', async () => {
    await api().post('/api/auth/register').send(body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    expect(user?.passwordHash).not.toBe(body.password);
    expect(await bcrypt.compare(body.password, user!.passwordHash!)).toBe(true);
  });

  it('gives the new gym a starter price list', async () => {
    const res = await api().post('/api/auth/register').send(body);
    const plans = await prisma.membershipPlan.findMany({ where: { gymId: res.body.user.gymId } });
    expect(plans.map(p => p.name).sort()).toEqual(['3 Months', 'Monthly', 'Yearly']);
  });

  it('rejects a duplicate email', async () => {
    await api().post('/api/auth/register').send(body);
    const res = await api().post('/api/auth/register').send(body);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.user.count({ where: { email: body.email } })).toBe(1);
  });

  it.each([
    ['a short password', { ...body, password: 'short' }],
    ['a malformed email', { ...body, email: 'not-an-email' }],
    ['a missing gym name', { ...body, gymName: undefined }],
    ['a missing owner name', { ...body, ownerName: undefined }],
  ])('rejects %s', async (_label, payload) => {
    const res = await api().post('/api/auth/register').send(payload);
    expect(res.status).toBe(400);
    expect(await prisma.user.count()).toBe(0);
  });
});

describe('POST /api/auth/login', () => {
  it('signs in with the right password and sets an httpOnly cookie', async () => {
    const { email } = await makeGym({ password: 'correct-horse-battery' });

    const res = await api().post('/api/auth/login')
      .send({ email, password: 'correct-horse-battery' });

    expect(res.status).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('rejects a wrong password without saying which field was wrong', async () => {
    const { email } = await makeGym();

    const res = await api().post('/api/auth/login').send({ email, password: 'wrong-password' });

    expect(res.status).toBe(401);
    expect(sessionCookie(res)).toBeUndefined();
    expect(JSON.stringify(res.body).toLowerCase()).not.toMatch(/password is|no such|not found/);
  });

  it('answers an unknown address the same way as a wrong password', async () => {
    const { email } = await makeGym();
    const wrongPass = await api().post('/api/auth/login').send({ email, password: 'wrong-password' });
    const unknown = await api().post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong-password' });

    // Identical responses, so login cannot be used to enumerate accounts.
    expect(unknown.status).toBe(wrongPass.status);
    expect(unknown.body).toEqual(wrongPass.body);
  });

  it('refuses a deactivated account, telling them why', async () => {
    const { email } = await makeGym({ isActive: false, password: 'correct-horse-battery' });

    const res = await api().post('/api/auth/login')
      .send({ email, password: 'correct-horse-battery' });

    // 403 and an explicit message, not the generic 401: the password was
    // right, and somebody whose account was switched off needs to know to ask
    // their gym rather than keep retrying. The check sits after the password
    // comparison, so it leaks nothing to a stranger guessing addresses.
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/deactivated/i);
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('does not reveal deactivation to someone who has the password wrong', async () => {
    const { email } = await makeGym({ isActive: false, password: 'correct-horse-battery' });

    const res = await api().post('/api/auth/login').send({ email, password: 'wrong-password' });

    expect(res.status).toBe(401);
    expect(res.body.error).not.toMatch(/deactivated/i);
  });

  it('refuses an invited account that has not set a password yet', async () => {
    const owner = await makeGym();
    const invited = await prisma.user.create({
      data: {
        gymId: owner.gymId,
        email: 'invited@example.com',
        name: 'Invited',
        role: 'staff',
        passwordHash: null,
      },
    });

    // A null hash must not be sign-in-able with a blank password, or any other.
    for (const password of ['', 'anything', 'null']) {
      const res = await api().post('/api/auth/login').send({ email: invited.email, password });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(sessionCookie(res)).toBeUndefined();
    }
  });
});

describe('login rate limiting', () => {
  // These use rawApi(), so the limiter the rest of the suite bypasses is live.
  // Without them, the bypass could hide a limiter that had stopped working.
  //
  // The limiter counts per IP and its window outlives the test run, so each
  // case forges a distinct X-Forwarded-For to get a fresh budget. That needs
  // trust proxy > 0, which the test env sets.
  const from = (ip: string) => rawApi().post('/api/auth/login').set('X-Forwarded-For', ip);

  it('throttles repeated failed logins from one address', async () => {
    const { email } = await makeGym();

    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      codes.push((await from('10.1.1.1').send({ email, password: 'wrong-password' })).status);
    }

    expect(codes.filter(c => c === 401).length).toBe(10);
    expect(codes.at(-1)).toBe(429);
  });

  it('does not count successful logins toward the limit', async () => {
    const { email } = await makeGym({ password: 'correct-horse-battery' });

    // skipSuccessfulRequests means a busy gym signing in legitimately is never
    // locked out, however many times it happens.
    for (let i = 0; i < 12; i++) {
      expect((await from('10.2.2.2').send({ email, password: 'correct-horse-battery' })).status)
        .toBe(200);
    }
  });

  it('throttles one address without affecting another', async () => {
    const { email } = await makeGym();

    for (let i = 0; i < 11; i++) {
      await from('10.3.3.3').send({ email, password: 'wrong-password' });
    }

    expect((await from('10.3.3.3').send({ email, password: 'wrong-password' })).status).toBe(429);
    // A second gym on a different connection must not be locked out by the first.
    expect((await from('10.4.4.4').send({ email, password: 'wrong-password' })).status).toBe(401);
  });
});

describe('GET /api/auth/me', () => {
  it('returns the signed-in account', async () => {
    const owner = await makeGym();

    const res = await api().get('/api/auth/me').set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body.user ?? res.body).toMatchObject({ email: owner.email, role: 'owner' });
  });

  it('rejects a request with no session', async () => {
    const res = await api().get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const owner = await makeGym();
    const forged = cookieFor(owner.userId).replace(/\.[^.]+$/, '.forged-signature');

    const res = await api().get('/api/auth/me').set('Cookie', forged);

    expect(res.status).toBe(401);
  });

  it('accepts a Bearer header for non-browser clients', async () => {
    const owner = await makeGym();
    const token = owner.cookie.replace('gym_session=', '');

    const res = await api().get('/api/auth/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  it('rejects a session for an account deactivated after the token was issued', async () => {
    const owner = await makeGym();
    await prisma.user.update({ where: { id: owner.userId }, data: { isActive: false } });

    // The role and active flag are read from the database on every request, so
    // revoking access must not wait for the 30-day token to expire.
    const res = await api().get('/api/auth/me').set('Cookie', owner.cookie);

    expect(res.status).toBe(401);
  });

  it('strands tokens issued before a tokenVersion bump', async () => {
    const owner = await makeGym();
    const stale = cookieFor(owner.userId, 0);
    await prisma.user.update({ where: { id: owner.userId }, data: { tokenVersion: 1 } });

    expect((await api().get('/api/auth/me').set('Cookie', stale)).status).toBe(401);
    // A token carrying the new version still works.
    expect((await api().get('/api/auth/me').set('Cookie', cookieFor(owner.userId, 1))).status)
      .toBe(200);
  });

  it('reflects a role change on the next request', async () => {
    const owner = await makeGym();
    const staff = await addUser(owner.gymId, { role: 'staff' });

    await prisma.user.update({ where: { id: staff.userId }, data: { role: 'owner' } });
    const res = await api().get('/api/auth/me').set('Cookie', staff.cookie);

    expect((res.body.user ?? res.body).role).toBe('owner');
  });
});

describe('POST /api/auth/change-password', () => {
  it('changes the password and revokes existing sessions', async () => {
    const owner = await makeGym({ password: 'correct-horse-battery' });

    const res = await api().post('/api/auth/change-password')
      .set('Cookie', owner.cookie)
      .send({ currentPassword: 'correct-horse-battery', newPassword: 'a-brand-new-password' });

    expect(res.status).toBe(200);

    // The old cookie must stop working — that is the point of the version bump.
    expect((await api().get('/api/auth/me').set('Cookie', owner.cookie)).status).toBe(401);

    const login = await api().post('/api/auth/login')
      .send({ email: owner.email, password: 'a-brand-new-password' });
    expect(login.status).toBe(200);
  });

  it('refuses when the current password is wrong', async () => {
    const owner = await makeGym({ password: 'correct-horse-battery' });

    const res = await api().post('/api/auth/change-password')
      .set('Cookie', owner.cookie)
      .send({ currentPassword: 'not-the-password', newPassword: 'a-brand-new-password' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    const login = await api().post('/api/auth/login')
      .send({ email: owner.email, password: 'correct-horse-battery' });
    expect(login.status).toBe(200);
  });
});

describe('POST /api/auth/forgot-password', () => {
  it('answers the same for a known and an unknown address', async () => {
    const { email } = await makeGym();

    const known = await api().post('/api/auth/forgot-password').send({ email });
    const unknown = await api().post('/api/auth/forgot-password')
      .send({ email: 'nobody@example.com' });

    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
  });

  it('stores the reset token only as a hash', async () => {
    const owner = await makeGym();

    await api().post('/api/auth/forgot-password').send({ email: owner.email });

    const user = await prisma.user.findUnique({ where: { id: owner.userId } });
    expect(user?.resetTokenHash).toBeTruthy();
    // A SHA-256 hex digest, not a token anyone could present.
    expect(user!.resetTokenHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
