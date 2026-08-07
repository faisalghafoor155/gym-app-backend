import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../db.js';
import { SESSION_COOKIE } from '../services/session.js';
import type { JwtPayload } from '../types.js';

export default async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  // The session normally arrives in an httpOnly cookie. The Bearer header is
  // still accepted so non-browser clients (scripts, curl) can authenticate.
  const header = req.headers.authorization;
  const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE]
    ?? (header?.startsWith('Bearer ') ? header.slice(7) : undefined);

  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
  } catch {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  try {
    // The role is read from the database rather than trusted from the token, so
    // revoking access or changing a role takes effect on the next request
    // instead of whenever a 30-day token happens to expire.
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true, gymId: true, name: true, role: true, isActive: true,
        memberId: true, tokenVersion: true,
      },
    });

    if (!user || !user.isActive) {
      res.status(401).json({ error: 'Account is no longer active' });
      return;
    }

    // Signing out, a password change or a role change bumps the stored version,
    // which strands every token signed before it. The account row is already
    // loaded above, so this costs nothing extra.
    if (payload.tokenVersion !== user.tokenVersion) {
      res.status(401).json({ error: 'Session expired. Please sign in again.' });
      return;
    }

    const r = req as Request & {
      gymId: string; userId: string; role: typeof user.role;
      actorName: string; memberId: string | null;
    };
    r.gymId = user.gymId;
    r.userId = user.id;
    r.role = user.role;
    r.actorName = user.name;
    r.memberId = user.memberId;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
