import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../db.js';
import { setSessionCookie, clearSessionCookie } from '../services/session.js';
import type { AuthedRequest } from '../types.js';
import type {
  RegisterBody, LoginBody, ForgotPasswordBody, ResetPasswordBody,
  GoogleAuthBody, ChangePasswordBody,
} from '../schemas.js';
import { verifyGoogleToken } from '../services/google.js';

/** A reset link is short-lived; an old inbox should not be a way in. */
const RESET_TTL_MS = 60 * 60 * 1000;

/**
 * Signs the session into an httpOnly cookie and returns the body. The token
 * itself never reaches the response body, so no script can read it.
 */
const startSession = (res: Response, user: {
  id: string; name: string; email: string; role: string; memberId: string | null;
  gym: { id: string; name: string; ownerName: string };
}) => {
  setSessionCookie(res, user.id);
  return {
    user: {
      id: user.id, name: user.name, email: user.email,
      role: user.role, memberId: user.memberId,
    },
    gym: { id: user.gym.id, name: user.gym.name, ownerName: user.gym.ownerName },
  };
};

const sessionInclude = {
  gym: { select: { id: true, name: true, ownerName: true } },
} as const;

/** Public signup creates a NEW gym; the account that creates it is its owner. */
export const register = async (
  req: Request<unknown, unknown, RegisterBody>,
  res: Response,
): Promise<void> => {
  const { gymName, ownerName, email, password, phone } = req.body;
  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.$transaction(async (tx) => {
      const gym = await tx.gym.create({ data: { name: gymName, ownerName, phone } });
      return tx.user.create({
        data: {
          gymId: gym.id, email, passwordHash,
          name: ownerName, role: 'owner',
          lastLoginAt: new Date(),
        },
        include: sessionInclude,
      });
    });

    res.status(201).json(startSession(res, user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const login = async (
  req: Request<unknown, unknown, LoginBody>,
  res: Response,
): Promise<void> => {
  const { email, password } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { email }, include: sessionInclude });

    // The same message for "no such account" and "wrong password" so the
    // endpoint cannot be used to discover which emails are registered.
    if (!user?.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    if (!user.isActive) {
      res.status(403).json({ error: 'This account has been deactivated' });
      return;
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    res.json(startSession(res, user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Signs in with a Google ID token. Only links to an account that already
 * exists — a Google login cannot create a gym or grant itself membership.
 */
export const googleAuth = async (
  req: Request<unknown, unknown, GoogleAuthBody>,
  res: Response,
): Promise<void> => {
  try {
    const profile = await verifyGoogleToken(req.body.credential);
    if (!profile) {
      res.status(401).json({ error: 'Google sign-in failed' });
      return;
    }

    const user = await prisma.user.findFirst({
      where: { OR: [{ googleId: profile.googleId }, { email: profile.email }] },
      include: sessionInclude,
    });
    if (!user) {
      res.status(404).json({ error: 'No account found for this Google address. Ask your gym to add you first.' });
      return;
    }
    if (!user.isActive) {
      res.status(403).json({ error: 'This account has been deactivated' });
      return;
    }

    // First Google sign-in on an existing password account links the two.
    await prisma.user.update({
      where: { id: user.id },
      data: { googleId: profile.googleId, lastLoginAt: new Date() },
    });

    res.json(startSession(res, user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Always answers the same way whether or not the address exists, so this
 * cannot be used to enumerate accounts.
 */
export const forgotPassword = async (
  req: Request<unknown, unknown, ForgotPasswordBody>,
  res: Response,
): Promise<void> => {
  const reply = { message: 'If that email is registered, a reset link has been sent.' };
  try {
    const user = await prisma.user.findUnique({ where: { email: req.body.email } });
    if (!user || !user.isActive) {
      res.json(reply);
      return;
    }

    // Only the hash is stored, so a database leak does not hand over live
    // reset links.
    const token = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = crypto.createHash('sha256').update(token).digest('hex');

    await prisma.user.update({
      where: { id: user.id },
      data: { resetTokenHash, resetTokenAt: new Date() },
    });

    const link = `${process.env.APP_URL ?? 'http://localhost:8080'}/reset-password?token=${token}`;
    // No mail transport is configured yet; the link goes to the server log so
    // the flow is usable. Swap this for a real send when SMTP is set up.
    console.log(`[password reset] ${user.email} -> ${link}`);

    res.json(reply);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const resetPassword = async (
  req: Request<unknown, unknown, ResetPasswordBody>,
  res: Response,
): Promise<void> => {
  const { token, password } = req.body;
  try {
    const resetTokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const user = await prisma.user.findFirst({ where: { resetTokenHash } });

    const expired = !user?.resetTokenAt
      || Date.now() - user.resetTokenAt.getTime() > RESET_TTL_MS;
    if (!user || expired) {
      res.status(400).json({ error: 'This reset link is invalid or has expired' });
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(password, 10),
        resetTokenHash: null,
        resetTokenAt: null,
      },
    });

    res.json({ message: 'Password updated. You can sign in now.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const changePassword = async (
  req: AuthedRequest<Record<string, string>, unknown, ChangePasswordBody>,
  res: Response,
): Promise<void> => {
  const { currentPassword, newPassword } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    // An account created through Google has no password to confirm against;
    // setting one for the first time is allowed.
    if (user.passwordHash && !(await bcrypt.compare(currentPassword, user.passwordHash))) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(newPassword, 10) },
    });
    res.json({ message: 'Password changed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/** The cookie is httpOnly, so only the server can end the session. */
export const logout = (_req: Request, res: Response): void => {
  clearSessionCookie(res);
  res.json({ message: 'Signed out' });
};

/** Who am I — the frontend restores a session from the cookie, not from storage. */
export const me = async (req: AuthedRequest, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      include: sessionInclude,
    });
    if (!user) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    res.json({
      user: {
        id: user.id, name: user.name, email: user.email,
        role: user.role, memberId: user.memberId,
      },
      gym: user.gym,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
