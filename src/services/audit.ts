import { Prisma, type Role } from '@prisma/client';
import prisma from '../db.js';
import type { AuthedRequest } from '../types.js';

/**
 * Everything a mutation records about itself. `before`/`after` should carry
 * only the fields that actually changed — a log that dumps whole rows is a log
 * nobody reads when it matters.
 */
export interface AuditEntry {
  action: string;
  entity: string;
  entityId: string;
  entityLabel?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/** Photos are data-URLs hundreds of kilobytes long; nothing about them belongs
 *  in an audit row, and one would push every other field off the screen. */
const REDACTED = new Set(['photo', 'password', 'passwordHash', 'currentPassword', 'newPassword']);

const scrub = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(scrub);
  if (value instanceof Date) return value;
  // A Decimal would otherwise be walked as a plain object and stored as its
  // internal digit representation, which is unreadable in a log.
  if (value instanceof Prisma.Decimal) return value.toNumber();

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, REDACTED.has(k) ? '[redacted]' : scrub(v)]),
  );
};

/**
 * Records who did what. Call at the end of a mutation that has already
 * succeeded — never before, or a rolled-back write leaves a log entry claiming
 * something happened that did not.
 *
 * Deliberately never throws. If the audit table is unavailable the gym must
 * still be able to take a payment; losing the trail is bad, refusing the
 * money is worse. Failures go to the server log instead.
 */
export const audit = async (
  req: AuthedRequest<never, never, never, never> | AuthedRequest<any, any, any, any>,
  entry: AuditEntry,
): Promise<void> => {
  try {
    await prisma.auditLog.create({
      data: {
        gymId: req.gymId,
        actorId: req.userId,
        // Copied rather than joined: the trail has to stay readable after the
        // account is renamed or removed, which is when it is most read.
        actorName: req.actorName,
        actorRole: req.role as Role,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        entityLabel: entry.entityLabel ?? null,
        before: entry.before === undefined ? undefined : (scrub(entry.before) as never),
        after: entry.after === undefined ? undefined : (scrub(entry.after) as never),
        reason: entry.reason ?? null,
      },
    });
  } catch (err) {
    console.error('[audit] failed to record', entry.action, entry.entityId, err);
  }
};

/**
 * Narrows two versions of a row down to just what changed, which is all an
 * audit entry should carry. Returns null when nothing differs, so a no-op
 * update does not leave a misleading "updated" entry behind.
 */
export const diff = <T extends Record<string, unknown>>(
  before: T,
  after: T,
  fields: readonly (keyof T)[],
): { before: Partial<T>; after: Partial<T> } | null => {
  const b: Partial<T> = {};
  const a: Partial<T> = {};

  for (const f of fields) {
    const from = before[f];
    const to = after[f];
    // Dates and Decimals are objects, so `===` compares identity: two equal
    // values would otherwise read as a change on every single save, and the
    // log would fill with edits that never happened.
    const same = from instanceof Date && to instanceof Date
      ? from.getTime() === to.getTime()
      : from instanceof Prisma.Decimal && to instanceof Prisma.Decimal
        ? from.equals(to)
        : from === to;
    if (!same) { b[f] = from; a[f] = to; }
  }

  return Object.keys(a).length ? { before: b, after: a } : null;
};
