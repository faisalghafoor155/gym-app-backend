import type { Response } from 'express';
import prisma from '../db.js';
import { endOfDayUtc } from '../services/dates.js';
import type { AuthedRequest } from '../types.js';
import type { AuditLogQuery } from '../schemas.js';

/**
 * The trail, newest first. Owner-only: it names which member of staff did
 * what, which is the owner's business and nobody else's.
 *
 * Paginated from the start — this is the one table that only ever grows.
 */
export const getAll = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, AuditLogQuery>,
  res: Response,
): Promise<void> => {
  const { entity, actorId, from, to, page, limit } = req.query;
  try {
    // `to` names a day, so include everything that happened during it.
    const toEnd = to ? endOfDayUtc(to) : undefined;

    const where = {
      gymId: req.gymId,
      ...(entity && { entity }),
      ...(actorId && { actorId }),
      ...((from ?? toEnd) && {
        createdAt: { ...(from && { gte: from }), ...(toEnd && { lte: toEnd }) },
      }),
    };

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      data: logs,
      total,
      page,
      limit,
      hasMore: page * limit < total,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
