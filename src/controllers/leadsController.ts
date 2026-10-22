import type { Response } from 'express';
import { Prisma, type LeadStatus } from '@prisma/client';
import prisma from '../db.js';
import { audit, diff } from '../services/audit.js';
import { addDays, startOfDay } from '../services/membership.js';
import type { AuthedRequest } from '../types.js';
import type {
  ConvertLeadBody, CreateLeadBody, IdParam, LeadQuery, UpdateLeadBody,
} from '../schemas.js';

/**
 * Enquiries: people who asked about the gym and have not joined yet.
 *
 * The point of the module is the follow-up date. A walk-in told "come back
 * after Eid" is revenue only if somebody remembers to call after Eid, and the
 * `due` filter is that memory — every lead whose follow-up is today or behind
 * it, oldest first.
 */

const include = {
  convertedMember: { select: { id: true, name: true, memberNo: true } },
  createdBy: { select: { id: true, name: true } },
} as const;

/** Leads still being worked: anyone not yet won or given up on. */
const OPEN: LeadStatus[] = ['new', 'contacted', 'trial'];

/** Follow-ups due by the end of today, which is what "call today" means. */
const dueWhere = (now: Date): Prisma.LeadWhereInput => ({
  status: { in: OPEN },
  followUpOn: { lt: addDays(startOfDay(now), 1) },
});

export const getAll = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, LeadQuery>,
  res: Response,
): Promise<void> => {
  const { status, due, search, page, limit } = req.query;
  try {
    const now = new Date();
    const where: Prisma.LeadWhereInput = {
      gymId: req.gymId,
      ...(status && { status: status === 'open' ? { in: OPEN } : status }),
      ...(due && dueWhere(now)),
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' as const } },
          { phone: { contains: search, mode: 'insensitive' as const } },
          { interest: { contains: search, mode: 'insensitive' as const } },
        ],
      }),
    };

    const [leads, total, byStatus, dueCount] = await Promise.all([
      prisma.lead.findMany({
        where,
        include,
        // The due list is worked oldest-promise-first; everything else reads
        // newest first, like the rest of the app's lists.
        orderBy: due
          ? [{ followUpOn: 'asc' }, { createdAt: 'asc' }]
          : [{ createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.lead.count({ where }),
      // The tab counts are over the gym's whole list, not the filtered page —
      // a count that changed as you typed in the search box would be noise.
      prisma.lead.groupBy({
        by: ['status'],
        where: { gymId: req.gymId },
        _count: { _all: true },
      }),
      prisma.lead.count({ where: { gymId: req.gymId, ...dueWhere(now) } }),
    ]);

    const counts = Object.fromEntries(
      (['new', 'contacted', 'trial', 'converted', 'lost'] as const).map(s => [
        s,
        byStatus.find(b => b.status === s)?._count._all ?? 0,
      ]),
    );

    res.json({
      data: leads,
      total,
      page,
      limit,
      hasMore: page * limit < total,
      counts: { ...counts, due: dueCount },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const create = async (
  req: AuthedRequest<Record<string, string>, unknown, CreateLeadBody>,
  res: Response,
): Promise<void> => {
  const { name, phone, source, interest, notes, status, followUpOn } = req.body;
  try {
    const lead = await prisma.lead.create({
      data: {
        gymId: req.gymId,
        name,
        phone: phone ?? null,
        source,
        interest: interest ?? null,
        notes: notes ?? null,
        status,
        followUpOn: followUpOn ?? null,
        createdById: req.userId,
      },
      include,
    });

    await audit(req, {
      action: 'lead.create',
      entity: 'lead',
      entityId: lead.id,
      entityLabel: lead.name,
      after: { name, phone, source, status, followUpOn },
    });

    res.status(201).json(lead);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const update = async (
  req: AuthedRequest<IdParam, unknown, UpdateLeadBody>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  const { name, phone, source, interest, notes, status, followUpOn } = req.body;
  try {
    const existing = await prisma.lead.findFirst({ where: { id, gymId: req.gymId } });
    if (!existing) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }
    // A converted lead is a record of how a member found the gym. Reopening it
    // by editing its status would leave it pointing at a member while claiming
    // they never joined.
    if (existing.status === 'converted' && status !== undefined) {
      res.status(400).json({ error: 'This lead already joined — its status can no longer change' });
      return;
    }

    const updated = await prisma.lead.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(phone !== undefined && { phone }),
        ...(source !== undefined && { source }),
        ...(interest !== undefined && { interest }),
        ...(notes !== undefined && { notes }),
        ...(status !== undefined && { status }),
        ...(followUpOn !== undefined && { followUpOn }),
      },
      include,
    });

    const changed = diff(existing, updated, [
      'name', 'phone', 'source', 'interest', 'notes', 'status', 'followUpOn',
    ]);
    if (changed) {
      await audit(req, {
        action: 'lead.update',
        entity: 'lead',
        entityId: id,
        entityLabel: updated.name,
        before: changed.before,
        after: changed.after,
      });
    }

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const remove = async (
  req: AuthedRequest<IdParam>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  try {
    const existing = await prisma.lead.findFirst({ where: { id, gymId: req.gymId } });
    if (!existing) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    await prisma.lead.delete({ where: { id } });

    await audit(req, {
      action: 'lead.delete',
      entity: 'lead',
      entityId: id,
      entityLabel: existing.name,
      before: {
        name: existing.name,
        phone: existing.phone,
        source: existing.source,
        status: existing.status,
        followUpOn: existing.followUpOn,
      },
    });

    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Marks a lead as joined, naming the member they became.
 *
 * The member is registered first, through the ordinary registration flow,
 * and only then linked here. Registering *from* this endpoint would mean a
 * second copy of everything registration does — the plan limit, the member
 * number, the fee, the duplicate check — and the copy would drift.
 */
export const convert = async (
  req: AuthedRequest<IdParam, unknown, ConvertLeadBody>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  const { memberId } = req.body;
  try {
    const [lead, member] = await Promise.all([
      prisma.lead.findFirst({ where: { id, gymId: req.gymId } }),
      prisma.member.findFirst({
        where: { id: memberId, gymId: req.gymId },
        select: { id: true, name: true, memberNo: true },
      }),
    ]);
    if (!lead) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }
    if (!member) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    if (lead.status === 'converted') {
      res.status(400).json({ error: 'This lead has already joined' });
      return;
    }

    let updated;
    try {
      updated = await prisma.lead.update({
        where: { id },
        data: {
          status: 'converted',
          convertedMemberId: member.id,
          convertedAt: new Date(),
        },
        include,
      });
    } catch (err) {
      // One person joins once: the unique link is what says so when two
      // leads are converted into the same member.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        res.status(409).json({ error: 'That member is already linked to another lead' });
        return;
      }
      throw err;
    }

    await audit(req, {
      action: 'lead.convert',
      entity: 'lead',
      entityId: id,
      entityLabel: lead.name,
      before: { status: lead.status },
      after: { status: 'converted', memberId: member.id, memberNo: member.memberNo },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
