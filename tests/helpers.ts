import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import prisma from '../src/db.js';
import app from '../src/index.js';

/**
 * Shared fixtures for the integration suite.
 *
 * Every helper writes through Prisma rather than the API, so a test for one
 * endpoint is not held hostage by a bug in another. The one exception is
 * `register`, which deliberately goes through HTTP because gym creation is
 * itself the thing under test in several cases.
 */

/**
 * The app under test, with rate limiting bypassed.
 *
 * The whole suite shares one IP, so ten failed logins anywhere would start
 * returning 429 to every later test. `rawApi` keeps the limiter on for the
 * tests that assert it works.
 */
export const api = () => {
  const agent = request(app);
  const methods = ['get', 'post', 'put', 'patch', 'delete'] as const;
  for (const m of methods) {
    const original = agent[m].bind(agent);
    agent[m] = (url: string) => original(url).set('x-test-skip-ratelimit', '1');
  }
  return agent;
};

/** The app with the rate limiter live, for the tests that exercise it. */
export const rawApi = () => request(app);

/**
 * Empties every table between tests.
 *
 * TRUNCATE ... CASCADE in one statement rather than ordered deletes, so it
 * cannot break when a new foreign key is added. The table list is read from
 * the catalogue for the same reason — a new model needs no change here.
 * `_prisma_migrations` is excluded, or the schema would look unmigrated.
 */
export const resetDb = async (): Promise<void> => {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (tables.length === 0) return;
  const list = tables.map(t => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
};

/** A signed session cookie for a user id, as `setSessionCookie` would issue. */
export const cookieFor = (userId: string, tokenVersion = 0): string => {
  const token = jwt.sign({ userId, tokenVersion }, process.env.JWT_SECRET!, { expiresIn: '30d' });
  return `gym_session=${token}`;
};

export interface TestAccount {
  userId: string;
  gymId: string;
  email: string;
  cookie: string;
}

/**
 * A gym with one account in it, ready to make requests.
 *
 * Passwords are hashed with a low cost factor: these rows are thrown away
 * within milliseconds, and bcrypt's default rounds would dominate the runtime
 * of the whole suite.
 */
export const makeGym = async (opts: {
  role?: 'owner' | 'staff' | 'member';
  gymName?: string;
  email?: string;
  password?: string;
  isActive?: boolean;
} = {}): Promise<TestAccount> => {
  const {
    role = 'owner',
    gymName = 'Test Gym',
    email = `${role}-${crypto.randomUUID()}@example.com`,
    password = 'correct-horse-battery',
    isActive = true,
  } = opts;

  const gym = await prisma.gym.create({ data: { name: gymName, ownerName: `${role} user` } });
  const user = await prisma.user.create({
    data: {
      gymId: gym.id,
      email,
      name: `${role} user`,
      passwordHash: await bcrypt.hash(password, 4),
      role,
      isActive,
    },
  });

  return { userId: user.id, gymId: gym.id, email, cookie: cookieFor(user.id) };
};

/** An extra account inside an existing gym. */
export const addUser = async (
  gymId: string,
  opts: { role?: 'owner' | 'staff' | 'member'; memberId?: string; email?: string; staffPermission?: string } = {},
): Promise<TestAccount> => {
  const { role = 'staff', memberId, email = `${role}-${crypto.randomUUID()}@example.com`, staffPermission } = opts;
  const user = await prisma.user.create({
    data: {
      gymId,
      email,
      name: `${role} user`,
      passwordHash: await bcrypt.hash('correct-horse-battery', 4),
      role,
      ...(memberId && { memberId }),
      ...(role === 'staff' && staffPermission && { staffPermission }),
    },
  });
  return { userId: user.id, gymId, email, cookie: cookieFor(user.id) };
};

/** A member record, with the gym's member counter kept consistent. */
export const addMember = async (
  gymId: string,
  opts: { name?: string; phone?: string; status?: string } = {},
): Promise<{ id: string; name: string }> => {
  const { name = 'Test Member', phone = '03001234567', status = 'active' } = opts;
  const gym = await prisma.gym.update({
    where: { id: gymId },
    data: { memberSeq: { increment: 1 } },
    select: { memberSeq: true },
  });
  const member = await prisma.member.create({
    data: {
      gymId,
      name,
      phone,
      status,
      memberNo: `MEM-${String(gym.memberSeq).padStart(5, '0')}`,
    },
    select: { id: true, name: true },
  });
  return member;
};

/**
 * A membership expiring a given number of days from now — negative for one that
 * already lapsed.
 *
 * The expiry is set directly rather than derived from a plan duration, because
 * what the status filters key off is the expiry date itself. Offsets are taken
 * from midnight to match `daysUntil`, so `days: 0` means "expires today"
 * whatever time the suite happens to run at.
 */
export const addMembership = async (
  gymId: string,
  memberId: string,
  opts: {
    planId?: string;
    expiresInDays?: number;
    status?: 'active' | 'expired' | 'suspended' | 'cancelled' | 'superseded';
  } = {},
): Promise<{ id: string }> => {
  const { expiresInDays = 30, status = 'active' } = opts;
  const planId = opts.planId ?? (await addPlan(gymId)).id;

  const expiry = new Date();
  expiry.setHours(0, 0, 0, 0);
  expiry.setDate(expiry.getDate() + expiresInDays);
  const start = new Date(expiry);
  start.setDate(start.getDate() - 30);

  return prisma.membership.create({
    data: {
      gymId,
      memberId,
      planId,
      startDate: start,
      expiryDate: expiry,
      originalExpiryDate: expiry,
      pricePaid: 2500,
      status,
    },
    select: { id: true },
  });
};

/** A membership plan to sell. */
export const addPlan = async (
  gymId: string,
  opts: { name?: string; price?: number; durationDays?: number } = {},
): Promise<{ id: string; price: number; durationDays: number }> => {
  const { name = 'Monthly', price = 2500, durationDays = 30 } = opts;
  const plan = await prisma.membershipPlan.create({
    data: { gymId, name, price, durationDays },
    select: { id: true, durationDays: true },
  });
  return { ...plan, price };
};
