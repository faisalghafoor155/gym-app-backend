import { beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import speakeasy from 'speakeasy';

import prisma from '../../src/db.js';
import { api, cookieFor, makeGym, resetDb } from '../helpers.js';

beforeEach(resetDb);

/** Pulls the session cookie's value out of a response's Set-Cookie header. */
const sessionCookie = (res: { headers: Record<string, unknown> }): string | undefined => {
  const raw = res.headers['set-cookie'] as string[] | undefined;
  return raw?.find(c => c.startsWith('gym_session='));
};

/** The current code for a secret, as the authenticator app would show it. */
const totp = (secret: string): string => speakeasy.totp({ secret, encoding: 'base32' });

const BACKUP_CODE = '1234-5678';

/**
 * Switches 2FA on for an account straight in the database, so the login-flow
 * tests do not depend on the setup endpoints they are not testing.
 */
const enableTwoFactor = async (userId: string): Promise<string> => {
  const { base32: secret } = speakeasy.generateSecret({ length: 32 });
  await prisma.user.update({
    where: { id: userId },
    data: {
      twoFactorEnabled: true,
      twoFactorSecret: secret,
      // Low cost factor, same reason as the fixture passwords: the row is
      // thrown away in milliseconds.
      twoFactorBackupCodes: JSON.stringify([await bcrypt.hash(BACKUP_CODE, 4)]),
    },
  });
  return secret;
};

/** Signs in far enough to hold a live 2FA challenge token. */
const loginChallenge = async (email: string, password = 'correct-horse-battery') => {
  const res = await api().post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res;
};

describe('2FA setup', () => {
  it('refuses to start without a session', async () => {
    const res = await api().get('/api/auth/two-factor/setup');
    expect(res.status).toBe(401);
  });

  it('sets up 2FA end to end: secret, QR, backup codes, confirmation', async () => {
    const account = await makeGym();

    const setup = await api().get('/api/auth/two-factor/setup').set('Cookie', account.cookie);
    expect(setup.status).toBe(200);
    expect(setup.body.qrCode).toContain('data:image');
    // Eight single-use codes in the xxxx-xxxx shape, from the crypto RNG.
    expect(setup.body.backupCodes).toHaveLength(8);
    for (const c of setup.body.backupCodes as string[]) {
      expect(c).toMatch(/^\d{4}-\d{4}$/);
    }

    const confirm = await api()
      .post('/api/auth/two-factor/verify-setup')
      .set('Cookie', account.cookie)
      .send({ code: totp(setup.body.secret), backupCodes: setup.body.backupCodes });
    expect(confirm.status).toBe(200);

    const status = await api().get('/api/auth/two-factor/status').set('Cookie', account.cookie);
    expect(status.body).toEqual({ enabled: true, remainingBackupCodes: 8 });

    // Only the hashes are kept — a database leak must not hand over live codes.
    const user = await prisma.user.findUnique({ where: { id: account.userId } });
    expect(user?.twoFactorBackupCodes).not.toContain(setup.body.backupCodes[0]);
  });

  it('rejects a wrong confirmation code and stays disabled', async () => {
    const account = await makeGym();
    const setup = await api().get('/api/auth/two-factor/setup').set('Cookie', account.cookie);

    const res = await api()
      .post('/api/auth/two-factor/verify-setup')
      .set('Cookie', account.cookie)
      .send({ code: '000000', backupCodes: setup.body.backupCodes });
    expect(res.status).toBe(400);

    const user = await prisma.user.findUnique({ where: { id: account.userId } });
    expect(user?.twoFactorEnabled).toBe(false);
  });
});

describe('login with 2FA enabled', () => {
  it('answers the password with a challenge, not a session', async () => {
    const { userId, email } = await makeGym({ password: 'correct-horse-battery' });
    await enableTwoFactor(userId);

    const res = await loginChallenge(email);

    expect(res.body.requiresTwoFactor).toBe(true);
    expect(typeof res.body.twoFactorToken).toBe('string');
    expect(sessionCookie(res)).toBeUndefined();
    // lastLoginAt stays untouched — the sign-in has not completed.
    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user?.lastLoginAt).toBeNull();
  });

  it('completes the sign-in with a valid authenticator code', async () => {
    const { userId, email } = await makeGym({ password: 'correct-horse-battery' });
    const secret = await enableTwoFactor(userId);
    const { body } = await loginChallenge(email);

    const res = await api()
      .post('/api/auth/two-factor/verify-login')
      .send({ token: body.twoFactorToken, code: totp(secret) });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
    const cookie = sessionCookie(res);
    expect(cookie).toContain('HttpOnly');

    // And the issued session really works.
    const me = await api().get('/api/auth/me').set('Cookie', cookie!);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);
  });

  it('rejects a wrong code and issues no session', async () => {
    const { userId, email } = await makeGym({ password: 'correct-horse-battery' });
    await enableTwoFactor(userId);
    const { body } = await loginChallenge(email);

    const res = await api()
      .post('/api/auth/two-factor/verify-login')
      .send({ token: body.twoFactorToken, code: '000000' });

    expect(res.status).toBe(401);
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('accepts a backup code, once', async () => {
    const { userId, email } = await makeGym({ password: 'correct-horse-battery' });
    await enableTwoFactor(userId);

    const first = await loginChallenge(email);
    const ok = await api()
      .post('/api/auth/two-factor/verify-login')
      .send({ token: first.body.twoFactorToken, code: BACKUP_CODE });
    expect(ok.status).toBe(200);

    // Consumed: the same code on a fresh challenge must fail.
    const second = await loginChallenge(email);
    const replay = await api()
      .post('/api/auth/two-factor/verify-login')
      .send({ token: second.body.twoFactorToken, code: BACKUP_CODE });
    expect(replay.status).toBe(401);
  });

  it('never accepts the challenge token itself as a session', async () => {
    const { userId, email } = await makeGym({ password: 'correct-horse-battery' });
    await enableTwoFactor(userId);
    const { body } = await loginChallenge(email);

    const res = await api()
      .get('/api/auth/me')
      .set('Cookie', `gym_session=${body.twoFactorToken}`);
    expect(res.status).toBe(401);
  });

  it('voids the challenge when the account changes underneath it', async () => {
    const { userId, email } = await makeGym({ password: 'correct-horse-battery' });
    const secret = await enableTwoFactor(userId);
    const { body } = await loginChallenge(email);

    // A password change bumps tokenVersion, stranding sessions — the pending
    // challenge must go with them.
    await prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });

    const res = await api()
      .post('/api/auth/two-factor/verify-login')
      .send({ token: body.twoFactorToken, code: totp(secret) });
    expect(res.status).toBe(401);
  });

  it('rejects a token that is not a challenge', async () => {
    const { userId, email } = await makeGym({ password: 'correct-horse-battery' });
    const secret = await enableTwoFactor(userId);
    await loginChallenge(email);

    // A real session token is signed with the same secret — it must still
    // not pass as a challenge.
    const sessionToken = cookieFor(userId).replace('gym_session=', '');
    const sessionAsChallenge = await api()
      .post('/api/auth/two-factor/verify-login')
      .send({ token: sessionToken, code: totp(secret) });
    expect(sessionAsChallenge.status).toBe(401);

    const garbage = await api()
      .post('/api/auth/two-factor/verify-login')
      .send({ token: 'garbage', code: totp(secret) });
    expect(garbage.status).toBe(401);
  });

  it('leaves accounts without 2FA exactly as before', async () => {
    const { email } = await makeGym({ password: 'correct-horse-battery' });

    const res = await loginChallenge(email);

    expect(res.body.requiresTwoFactor).toBeUndefined();
    expect(res.body.user.email).toBe(email);
    expect(sessionCookie(res)).toBeDefined();
  });
});

/**
 * Turning the second factor off.
 *
 * This used to need nothing but the session cookie, which made 2FA worth very
 * little: whoever stole a 30-day cookie could remove the protection that was
 * supposed to stop them using it, in one request, and keep the account. The
 * password is what the attacker holding the cookie does not have.
 */
describe('disabling 2FA', () => {
  const enabledAccount = async () => {
    const account = await makeGym({ password: 'correct-horse-battery' });
    const secret = await enableTwoFactor(account.userId);
    return { ...account, secret };
  };

  it('refuses without a password', async () => {
    const { userId, cookie } = await enabledAccount();

    const res = await api().delete('/api/auth/two-factor').set('Cookie', cookie).send({});

    expect(res.status).toBe(400);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user?.twoFactorEnabled).toBe(true);
  });

  it('refuses a wrong password, and leaves 2FA on', async () => {
    const { userId, cookie } = await enabledAccount();

    const res = await api()
      .delete('/api/auth/two-factor')
      .set('Cookie', cookie)
      .send({ password: 'not-the-password' });

    expect(res.status).toBe(401);
    // The check is worthless if the account is left unprotected anyway.
    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user?.twoFactorEnabled).toBe(true);
    expect(user?.twoFactorSecret).not.toBeNull();
  });

  it('disables with the right password, and clears the secret', async () => {
    const { userId, cookie } = await enabledAccount();

    const res = await api()
      .delete('/api/auth/two-factor')
      .set('Cookie', cookie)
      .send({ password: 'correct-horse-battery' });

    expect(res.status).toBe(200);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user?.twoFactorEnabled).toBe(false);
    // Left behind, the seed would still generate valid codes for an account
    // that no longer expects them.
    expect(user?.twoFactorSecret).toBeNull();
    expect(user?.twoFactorBackupCodes).toBeNull();
  });

  it('refuses when 2FA is not on, rather than reporting success', async () => {
    const { cookie } = await makeGym({ password: 'correct-horse-battery' });

    const res = await api()
      .delete('/api/auth/two-factor')
      .set('Cookie', cookie)
      .send({ password: 'correct-horse-battery' });

    expect(res.status).toBe(400);
  });

  it('refuses without a session at all', async () => {
    await enabledAccount();

    const res = await api()
      .delete('/api/auth/two-factor')
      .send({ password: 'correct-horse-battery' });

    expect(res.status).toBe(401);
  });
});

/**
 * The TOTP secret at rest.
 *
 * It is the seed that generates every code for an account. In plaintext, a
 * database dump hands over every staff member's second factor permanently —
 * and silently, because nothing about their authenticator app changes.
 */
describe('the stored TOTP secret', () => {
  it('is not readable in the database after setup', async () => {
    const { userId, cookie } = await makeGym({ password: 'correct-horse-battery' });

    const setup = await api().get('/api/auth/two-factor/setup').set('Cookie', cookie);
    expect(setup.status).toBe(200);
    const plainSecret = setup.body.secret as string;

    const during = await prisma.user.findUnique({ where: { id: userId } });
    // The half-finished setup is a working seed too, so it is covered as well.
    expect(during?.twoFactorTempSecret).not.toBe(plainSecret);
    expect(during?.twoFactorTempSecret).toMatch(/^v1\./);

    const verified = await api()
      .post('/api/auth/two-factor/verify-setup')
      .set('Cookie', cookie)
      .send({ code: totp(plainSecret), backupCodes: [BACKUP_CODE] });
    expect(verified.status).toBe(200);

    const after = await prisma.user.findUnique({ where: { id: userId } });
    expect(after?.twoFactorEnabled).toBe(true);
    expect(after?.twoFactorSecret).not.toBe(plainSecret);
    expect(after?.twoFactorSecret).toMatch(/^v1\./);
    // The base32 alphabet has no lowercase, so this would catch the seed being
    // written through unchanged even if the format check above were loosened.
    expect(after?.twoFactorSecret).not.toContain(plainSecret.slice(0, 16));
  });

  it('still signs in with the encrypted secret', async () => {
    // Encryption is worthless if it locks the owner out of their own account.
    const { userId, email, cookie } = await makeGym({ password: 'correct-horse-battery' });
    const setup = await api().get('/api/auth/two-factor/setup').set('Cookie', cookie);
    const plainSecret = setup.body.secret as string;
    await api()
      .post('/api/auth/two-factor/verify-setup')
      .set('Cookie', cookie)
      .send({ code: totp(plainSecret), backupCodes: [BACKUP_CODE] });

    const challenge = await api()
      .post('/api/auth/login')
      .set('x-test-skip-ratelimit', '1')
      .send({ email, password: 'correct-horse-battery' });
    expect(challenge.body.requiresTwoFactor).toBe(true);

    const res = await api()
      .post('/api/auth/two-factor/verify-login')
      .send({ token: challenge.body.twoFactorToken, code: totp(plainSecret) });

    expect(res.status).toBe(200);
    expect(sessionCookie(res)).toBeDefined();
    expect(userId).toBeTruthy();
  });

  it('still reads a secret written before encryption existed', async () => {
    // The rows already in every deployed database are plaintext. If those
    // stopped working, the deploy that added encryption would lock out every
    // account that had 2FA switched on.
    const { userId, email } = await makeGym({ password: 'correct-horse-battery' });
    const legacySecret = await enableTwoFactor(userId);

    const stored = await prisma.user.findUnique({ where: { id: userId } });
    expect(stored?.twoFactorSecret).toBe(legacySecret);

    const challenge = await api()
      .post('/api/auth/login')
      .set('x-test-skip-ratelimit', '1')
      .send({ email, password: 'correct-horse-battery' });

    const res = await api()
      .post('/api/auth/two-factor/verify-login')
      .send({ token: challenge.body.twoFactorToken, code: totp(legacySecret) });

    expect(res.status).toBe(200);
  });
});
