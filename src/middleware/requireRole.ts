import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Role } from '@prisma/client';

/**
 * Gates a route to the given roles. Must be mounted after `auth`, which is
 * what puts the role on the request.
 *
 * Roles are a strict hierarchy of trust:
 *   owner  — everything, including managing staff and transferring ownership
 *   staff  — day-to-day running of the gym (members, attendance, fees, plans)
 *   member — only their own data
 */
export const requireRole = (...allowed: Role[]): RequestHandler =>
  (req: Request, res: Response, next: NextFunction): void => {
    const role = (req as Request & { role?: Role }).role;
    if (!role || !allowed.includes(role)) {
      res.status(403).json({ error: 'You do not have permission to do that' });
      return;
    }
    next();
  };

/** Anything that keeps the gym running day to day. */
export const requireStaff = requireRole('owner', 'staff');

/** Ownership-level actions: staff accounts, ownership transfer, gym settings. */
export const requireOwner = requireRole('owner');
