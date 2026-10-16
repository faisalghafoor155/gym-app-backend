import { beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';

import prisma from '../../src/db.js';
import { GYM_CHECKIN_PURPOSE } from '../../src/services/gymCheckin.js';
import { SESSION_COOKIE } from '../../src/services/session.js';
import { addMember, addUser, api, makeGym, resetDb } from '../helpers.js';

/**
 * Self check-in from the gym's QR.
 *
 * The desk shows a rotating QR; a member scans it and their phone's session
 * checks them in. The token says "this gym, just now" and names nobody, so
 * both halves have to hold: a fresh token for the member's own gym, and a
 * session that belongs to a member.
 */

beforeEach(resetDb);

/** The desk's current QR token for a gym. */
const deskToken = async (cookie: string): Promise<string> => {
  const res = await api().get('/api/attendance/gym-qr').set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body.token as string;
};

/** A gym with an owner, and one member who has a login of their own. */
const gymWithMemberLogin = async () => {
  const owner = await makeGym();
  const member = await addMember(owner.gymId);
  const login = await addUser(owner.gymId, { role: 'member', memberId: member.id });
  return { owner, member, login };
};

describe('GET /api/attendance/gym-qr', () => {
  it('gives the desk a token and how often to rotate it', async () => {
    const owner = await makeGym();

    const res = await api().get('/api/attendance/gym-qr').set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.rotateSeconds).toBe(30);
  });

  it('is not handed to a member — the QR is the desk’s to show', async () => {
    const { login } = await gymWithMemberLogin();

    const res = await api().get('/api/attendance/gym-qr').set('Cookie', login.cookie);

    expect(res.status).toBe(403);
  });
});

describe('POST /api/me/checkin', () => {
  it('checks the scanning member in', async () => {
    const { owner, member, login } = await gymWithMemberLogin();
    const token = await deskToken(owner.cookie);

    const res = await api().post('/api/me/checkin').set('Cookie', login.cookie).send({ token });

    expect(res.status).toBe(201);
    expect(res.body.alreadyCheckedIn).toBe(false);
    const rows = await prisma.attendance.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].memberId).toBe(member.id);
  });

  it('answers a second scan the same day as already checked in, with no new row', async () => {
    const { owner, login } = await gymWithMemberLogin();
    const token = await deskToken(owner.cookie);

    await api().post('/api/me/checkin').set('Cookie', login.cookie).send({ token });
    const again = await api().post('/api/me/checkin').set('Cookie', login.cookie).send({ token });

    expect(again.status).toBe(200);
    expect(again.body.alreadyCheckedIn).toBe(true);
    expect(await prisma.attendance.count()).toBe(1);
  });

  it('agrees with the desk: a member checked in at the counter is not checked in twice', async () => {
    const { owner, member, login } = await gymWithMemberLogin();
    await api().post('/api/attendance/checkin').set('Cookie', owner.cookie).send({ memberId: member.id });

    const res = await api().post('/api/me/checkin').set('Cookie', login.cookie)
      .send({ token: await deskToken(owner.cookie) });

    expect(res.body.alreadyCheckedIn).toBe(true);
    expect(await prisma.attendance.count()).toBe(1);
  });

  it('refuses an expired code — a photo taken home stops working', async () => {
    const { owner, login } = await gymWithMemberLogin();
    const stale = jwt.sign(
      { gymId: owner.gymId, purpose: GYM_CHECKIN_PURPOSE, exp: Math.floor(Date.now() / 1000) - 5 },
      process.env.JWT_SECRET!,
    );

    const res = await api().post('/api/me/checkin').set('Cookie', login.cookie).send({ token: stale });

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('expired');
    expect(await prisma.attendance.count()).toBe(0);
  });

  it('refuses a token that is not a gym check-in token', async () => {
    const { owner, login } = await gymWithMemberLogin();
    const other = jwt.sign({ gymId: owner.gymId, purpose: 'two-factor' }, process.env.JWT_SECRET!);

    const res = await api().post('/api/me/checkin').set('Cookie', login.cookie).send({ token: other });

    expect(res.status).toBe(400);
    expect(await prisma.attendance.count()).toBe(0);
  });

  it('refuses another gym’s QR', async () => {
    const { login } = await gymWithMemberLogin();
    const elsewhere = await makeGym({ gymName: 'Other Gym' });

    const res = await api().post('/api/me/checkin').set('Cookie', login.cookie)
      .send({ token: await deskToken(elsewhere.cookie) });

    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('wrong_gym');
    expect(await prisma.attendance.count()).toBe(0);
  });

  it('tells a staff or owner account it is not a member, rather than checking anyone in', async () => {
    const owner = await makeGym();

    const res = await api().post('/api/me/checkin').set('Cookie', owner.cookie)
      .send({ token: await deskToken(owner.cookie) });

    expect(res.status).toBe(404);
    expect(res.body.reason).toBe('not_member');
    expect(await prisma.attendance.count()).toBe(0);
  });

  it('needs a signed-in session — the token alone names nobody', async () => {
    const { owner } = await gymWithMemberLogin();

    const res = await api().post('/api/me/checkin').send({ token: await deskToken(owner.cookie) });

    expect(res.status).toBe(401);
    expect(await prisma.attendance.count()).toBe(0);
  });

  it('cannot be used as a session cookie', async () => {
    const { owner } = await gymWithMemberLogin();
    const token = await deskToken(owner.cookie);

    const res = await api().get('/api/me').set('Cookie', `${SESSION_COOKIE}=${token}`);

    expect(res.status).toBe(401);
  });
});
