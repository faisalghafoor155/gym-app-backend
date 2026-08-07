import type { Response } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../db.js';

export const SESSION_COOKIE = 'gym_session';

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * The token lives in an httpOnly cookie so page scripts cannot read it — an
 * XSS bug can no longer walk off with a 30-day session.
 *
 * sameSite 'lax' is what makes this safe without CSRF tokens: the browser
 * withholds the cookie on cross-site POST/PUT/DELETE, so another origin cannot
 * drive the API using the user's session. It still rides along on top-level
 * navigations, which is what keeps a normal visit signed in.
 *
 * The account's tokenVersion is signed into the token so that bumping the
 * stored version retires every token issued before it.
 */
export const setSessionCookie = (res: Response, userId: string, tokenVersion: number): void => {
  const token = jwt.sign({ userId, tokenVersion }, process.env.JWT_SECRET!, { expiresIn: '30d' });

  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Secure would stop the cookie being stored over plain http in local dev.
    secure: process.env.NODE_ENV === 'production' && process.env.HTTPS !== 'false',
    maxAge: MAX_AGE_MS,
    path: '/',
  });
};

export const clearSessionCookie = (res: Response): void => {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' && process.env.HTTPS !== 'false',
    path: '/',
  });
};

/**
 * Retires every token already issued for an account. Call this anywhere the
 * old sessions must not survive the change: signing out, a new password, a
 * deactivation, or a different role.
 *
 * Increments in the database rather than reading and writing back, so two
 * concurrent revocations cannot land on the same number and leave one of the
 * old sessions alive.
 */
export const revokeSessions = async (userId: string): Promise<number> => {
  const { tokenVersion } = await prisma.user.update({
    where: { id: userId },
    data: { tokenVersion: { increment: 1 } },
    select: { tokenVersion: true },
  });
  return tokenVersion;
};
