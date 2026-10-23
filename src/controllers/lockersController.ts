import type { Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../db.js';
import { audit } from '../services/audit.js';
import { currentMembershipWhere, daysUntil, startOfDay } from '../services/membership.js';
import type { AuthedRequest } from '../types.js';
import type {
  AssignLockerBody, CreateLockersBody, IdParam, UpdateLockerBody,
} from '../schemas.js';

/**
 * The gym's lockers and who holds each one.
 *
 * A locker held by somebody whose membership has run out is the one that
 * matters: it is space a paying member could use, and it is flagged on every
 * read so the desk can free it — one at a time, or all at once.
 */

const holder = {
  select: {
    id: true,
    name: true,
    memberNo: true,
    phone: true,
    memberships: {
      where: currentMembershipWhere,
      orderBy: { startDate: 'desc' as const },
      take: 1,
      select: {
        expiryDate: true,
        status: true,
        plan: { select: { name: true, includesLocker: true } },
      },
    },
  },
} as const;

type LockerRow = Prisma.LockerGetPayload<{ include: { member: typeof holder } }>;

/** Compare lockers the way they are painted: "2" before "10". */
const byNumber = (a: { number: string }, b: { number: string }) =>
  a.number.localeCompare(b.number, undefined, { numeric: true, sensitivity: 'base' });

const toView = (l: LockerRow, now: Date) => {
  const ms = l.member?.memberships[0];
  const daysLeft = ms ? daysUntil(ms.expiryDate, now) : null;
  return {
    id: l.id,
    number: l.number,
    location: l.location,
    notes: l.notes,
    assignedAt: l.assignedAt,
    member: l.member
      ? {
          id: l.member.id,
          name: l.member.name,
          memberNo: l.member.memberNo,
          phone: l.member.phone,
          planName: ms?.plan.name ?? null,
          planIncludesLocker: ms?.plan.includesLocker ?? false,
          expiryDate: ms?.expiryDate ?? null,
          daysLeft,
        }
      : null,
    /** Held by somebody with no running membership. */
    holderExpired: !!l.member && (!ms || ms.status !== 'active' || (daysLeft ?? -1) < 0),
  };
};

export const getAll = async (req: AuthedRequest, res: Response): Promise<void> => {
  try {
    const now = new Date();
    const lockers = await prisma.locker.findMany({
      where: { gymId: req.gymId },
      include: { member: holder },
    });
    const data = lockers.sort(byNumber).map(l => toView(l, now));
    res.json({
      data,
      counts: {
        total: data.length,
        free: data.filter(l => !l.member).length,
        taken: data.filter(l => l.member).length,
        expired: data.filter(l => l.holderExpired).length,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const create = async (
  req: AuthedRequest<Record<string, string>, unknown, CreateLockersBody>,
  res: Response,
): Promise<void> => {
  const { number, from, to, prefix = '', location } = req.body;
  const numbers = number
    ? [number]
    : Array.from({ length: to! - from! + 1 }, (_, i) => `${prefix}${from! + i}`);
  try {
    // `skipDuplicates` so adding 1–40 to a gym that already has 1–20 adds the
    // other twenty rather than failing on the first one it has.
    const { count } = await prisma.locker.createMany({
      data: numbers.map(n => ({ gymId: req.gymId, number: n, location: location ?? null })),
      skipDuplicates: true,
    });
    if (count === 0) {
      res.status(409).json({ error: numbers.length === 1 ? 'That locker number already exists' : 'All of those lockers already exist' });
      return;
    }
    await audit(req, {
      action: 'locker.create',
      entity: 'locker',
      entityId: req.gymId,
      entityLabel: numbers.length === 1 ? `Locker ${numbers[0]}` : `Lockers ${numbers[0]}–${numbers.at(-1)}`,
      after: { added: count, location },
    });
    res.status(201).json({ added: count, skipped: numbers.length - count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

const find = (gymId: string, id: string) =>
  prisma.locker.findFirst({ where: { id, gymId }, include: { member: holder } });

export const update = async (
  req: AuthedRequest<IdParam, unknown, UpdateLockerBody>,
  res: Response,
): Promise<void> => {
  const { number, location, notes } = req.body;
  try {
    const existing = await find(req.gymId, req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Locker not found' });
      return;
    }
    const updated = await prisma.locker.update({
      where: { id: existing.id },
      data: {
        ...(number !== undefined && { number }),
        ...(location !== undefined && { location }),
        ...(notes !== undefined && { notes }),
      },
      include: { member: holder },
    });
    res.json(toView(updated, new Date()));
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      res.status(409).json({ error: 'That locker number already exists' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const remove = async (req: AuthedRequest<IdParam>, res: Response): Promise<void> => {
  try {
    const existing = await find(req.gymId, req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Locker not found' });
      return;
    }
    if (existing.memberId) {
      res.status(400).json({ error: 'Free the locker before removing it' });
      return;
    }
    await prisma.locker.delete({ where: { id: existing.id } });
    await audit(req, {
      action: 'locker.delete',
      entity: 'locker',
      entityId: existing.id,
      entityLabel: `Locker ${existing.number}`,
      before: { number: existing.number, location: existing.location },
    });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const assign = async (
  req: AuthedRequest<IdParam, unknown, AssignLockerBody>,
  res: Response,
): Promise<void> => {
  const { memberId, notes, feeAmount, feeMethod, channel, reference } = req.body;
  try {
    const [locker, member] = await Promise.all([
      find(req.gymId, req.params.id),
      prisma.member.findFirst({
        where: { id: memberId, gymId: req.gymId },
        select: {
          id: true,
          name: true,
          memberNo: true,
          locker: { select: { number: true } },
          memberships: {
            where: currentMembershipWhere,
            orderBy: { startDate: 'desc' },
            take: 1,
            select: { plan: { select: { includesLocker: true } } },
          },
        },
      }),
    ]);
    if (!locker) {
      res.status(404).json({ error: 'Locker not found' });
      return;
    }
    if (!member) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    if (locker.memberId) {
      res.status(400).json({ error: `Locker ${locker.number} is already taken by ${locker.member?.name ?? 'someone'}` });
      return;
    }
    if (member.locker) {
      res.status(400).json({ error: `${member.name} already has locker ${member.locker.number}` });
      return;
    }
    // A plan that includes a locker has already been paid for it, so a fee
    // here would charge the member twice for the same door.
    const covered = member.memberships[0]?.plan.includesLocker ?? false;
    const fee = !covered && feeAmount ? feeAmount : null;

    // One transaction: a locker handed over with its fee lost, or a fee
    // recorded for a locker someone else got first, is worse than neither.
    const [updated, payment] = await prisma.$transaction(async tx => {
      const assigned = await tx.locker.update({
        where: { id: locker.id },
        data: { memberId: member.id, assignedAt: new Date(), ...(notes !== undefined && { notes }) },
        include: { member: holder },
      });
      const paid = fee
        ? await tx.payment.create({
            data: {
              gymId: req.gymId,
              memberId: member.id,
              amount: fee,
              type: 'locker',
              method: feeMethod ?? 'cash',
              channel: feeMethod === 'online' ? channel ?? null : null,
              reference: reference ?? null,
              notes: `Locker ${locker.number}`,
              recordedById: req.userId,
            },
          })
        : null;
      return [assigned, paid] as const;
    });
    await audit(req, {
      action: 'locker.assign',
      entity: 'locker',
      entityId: locker.id,
      entityLabel: `Locker ${locker.number}`,
      after: {
        memberId: member.id,
        memberNo: member.memberNo,
        name: member.name,
        ...(covered && { coveredByPlan: true }),
        ...(payment && { paymentId: payment.id, fee }),
      },
    });
    // Said back so the desk knows whether money was taken, and why not.
    res.json({ ...toView(updated, new Date()), coveredByPlan: covered, feeRecorded: !!payment });
  } catch (err) {
    // Two desks giving the same member a locker at once: the unique key on
    // memberId is what says no to the second.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      res.status(400).json({ error: 'That member already has a locker' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const release = async (req: AuthedRequest<IdParam>, res: Response): Promise<void> => {
  try {
    const locker = await find(req.gymId, req.params.id);
    if (!locker) {
      res.status(404).json({ error: 'Locker not found' });
      return;
    }
    if (!locker.memberId) {
      res.status(400).json({ error: 'That locker is already free' });
      return;
    }
    const updated = await prisma.locker.update({
      where: { id: locker.id },
      data: { memberId: null, assignedAt: null },
      include: { member: holder },
    });
    await audit(req, {
      action: 'locker.release',
      entity: 'locker',
      entityId: locker.id,
      entityLabel: `Locker ${locker.number}`,
      before: { memberId: locker.memberId, name: locker.member?.name },
    });
    res.json(toView(updated, new Date()));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/** Frees every locker whose holder has no running membership. */
export const releaseExpired = async (req: AuthedRequest, res: Response): Promise<void> => {
  try {
    const now = new Date();
    const today = startOfDay(now);
    const held = await prisma.locker.findMany({
      where: { gymId: req.gymId, memberId: { not: null } },
      include: { member: holder },
    });
    const expired = held.filter(l => toView(l, now).holderExpired);
    if (expired.length === 0) {
      res.json({ released: 0 });
      return;
    }
    await prisma.locker.updateMany({
      where: { id: { in: expired.map(l => l.id) }, gymId: req.gymId },
      data: { memberId: null, assignedAt: null },
    });
    await audit(req, {
      action: 'locker.releaseExpired',
      entity: 'locker',
      entityId: req.gymId,
      entityLabel: `${expired.length} locker${expired.length === 1 ? '' : 's'}`,
      before: {
        asOf: today,
        lockers: expired.map(l => ({ number: l.number, member: l.member?.memberNo })),
      },
    });
    res.json({ released: expired.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
