import type { Response } from 'express';
import type { Prisma } from '@prisma/client';
import prisma from '../db.js';
import { audit, diff } from '../services/audit.js';
import {
  addDays, currentMembershipWhere, effectiveMemberStatus, formatMemberNo,
  memberStatusWhere, toView, withPlan,
} from '../services/membership.js';
import type { AuthedRequest } from '../types.js';
import type {
  CreateMemberBody, UpdateMemberBody, IdParam, MemberQuery, MemberStatusFilter,
} from '../schemas.js';

const memberFields = {
  id: true, gymId: true, memberNo: true, name: true, email: true, phone: true,
  photo: true, gender: true, dateOfBirth: true, address: true,
  emergencyContact: true, status: true, createdAt: true,
} as const;

/**
 * A member's current membership is the newest one that has not been replaced
 * or called off. Pulled as a one-element list so a member without one comes
 * back as an empty array rather than a failed join.
 */
const currentMembership = {
  where: currentMembershipWhere,
  orderBy: { createdAt: 'desc' },
  take: 1,
  include: withPlan,
} as const;

type MemberRow = Prisma.MemberGetPayload<{
  select: typeof memberFields & { memberships: typeof currentMembership };
}>;

/**
 * Flattens the one-element memberships list into the single field the API
 * promises, so clients never deal with the query's shape.
 *
 * `status` is overwritten with the effective one: a member whose membership
 * lapsed two months ago reads as `inactive` without anything having been
 * written to their row. `storedStatus` is kept alongside so a client can still
 * tell a hand-deactivated member from one the calendar retired.
 */
const decorate = ({ memberships, ...member }: MemberRow, now: Date = new Date()) => {
  const current = memberships[0] ?? null;
  return {
    ...member,
    status: effectiveMemberStatus(member.status, current, now),
    storedStatus: member.status,
    currentMembership: current ? toView(current, now) : null,
  };
};

const selectMember = { ...memberFields, memberships: currentMembership } as const;

/**
 * The same row without the photo, for the `all=true` pickers.
 *
 * Photos are base64 data-URLs of up to 2MB living inline on the row, so they
 * are the entire reason a full member list is expensive. A dropdown renders a
 * name, never a face, so leaving them out is what makes returning every member
 * affordable at all.
 */
const selectMemberLite = (() => {
  const { photo: _photo, ...rest } = memberFields;
  return { ...rest, memberships: currentMembership } as const;
})();

/**
 * The roster, newest first.
 *
 * Paged by default. Search and the status tabs are applied here rather than in
 * the browser: a client that filters what it was given can only ever search the
 * page it is holding, which turns a search box into a lie the moment the gym
 * outgrows one page.
 *
 * `all=true` opts out for the pickers that need every member — see the query
 * schema. That response drops photos and is still a single query, so the cost
 * is a name-sized row per member rather than a photo-sized one.
 */
export const getAll = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, MemberQuery>,
  res: Response,
): Promise<void> => {
  const { search, status, page, limit, all } = req.query;
  try {
    // One clock for the whole request, so the rows, the filter boundaries and
    // the count can never disagree about what "today" was.
    const now = new Date();

    const where = {
      gymId: req.gymId,
      // Whatever the front desk has to hand: a name, a number, or a phone.
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' as const } },
          { memberNo: { contains: search, mode: 'insensitive' as const } },
          { phone: { contains: search, mode: 'insensitive' as const } },
        ],
      }),
      // No tab chosen means "everyone still on the books", which excludes the
      // lapsed: somebody who stopped coming two months ago is reachable from
      // their own tab rather than cluttering the default list.
      //
      // Two things override that. A search, because someone typing a name wants
      // that person found and a box that silently refuses to return them reads
      // as broken search rather than as a filter. And `all`, because a picker
      // asking for every member means every member — a lapsed one is exactly
      // who the front desk is about to sell a renewal to.
      ...(status
        ? memberStatusWhere(status, now)
        : (search || all) ? {} : { NOT: memberStatusWhere('lapsed', now) }),
    };

    if (all) {
      const members = await prisma.member.findMany({
        where,
        select: selectMemberLite,
        orderBy: { createdAt: 'desc' },
      });
      // Same envelope as the paged response, so a caller never has to branch on
      // the shape of what came back — only `hasMore` differs, and it cannot be
      // true here by definition.
      res.json({
        data: members.map(m => decorate({ ...m, photo: null }, now)),
        total: members.length,
        page: 1,
        limit: members.length,
        hasMore: false,
      });
      return;
    }

    // The tab counts, which have to cover the whole roster rather than the page
    // — a tab labelled with what happens to be on screen is worse than one with
    // no number at all. Each is the same predicate the tab itself filters by, so
    // clicking a tab showing 12 always lands on 12 people.
    //
    // Counted against `searchWhere` rather than `where`: the tabs must keep
    // narrowing the current search, but must not narrow themselves by the tab
    // already selected, which would leave every other tab reading zero.
    const searchWhere = { gymId: req.gymId, ...(where.OR && { OR: where.OR }) };
    const countFor = (f: MemberStatusFilter) =>
      prisma.member.count({ where: { ...searchWhere, ...memberStatusWhere(f, now) } });

    const [members, total, active, expiring, expired, lapsed, none] = await Promise.all([
      prisma.member.findMany({
        where,
        select: selectMember,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.member.count({ where }),
      countFor('active'),
      countFor('expiring'),
      countFor('expired'),
      countFor('lapsed'),
      countFor('none'),
    ]);

    res.json({
      data: members.map(m => decorate(m, now)),
      total,
      page,
      limit,
      hasMore: page * limit < total,
      // "All" means everyone still on the books, which is everybody except the
      // lapsed — the same rule the page's All tab applies.
      counts: {
        all: active + expiring + expired + none,
        active, expiring, expired, lapsed, none,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const getOne = async (
  req: AuthedRequest<IdParam>,
  res: Response,
): Promise<void> => {
  try {
    const member = await prisma.member.findFirst({
      where: { id: req.params.id, gymId: req.gymId },
      select: selectMember,
    });
    if (!member) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    res.json(decorate(member));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Registers a member, optionally selling them a membership in the same breath
 * — which is what actually happens at the front desk when somebody walks in.
 *
 * The member number and, when a plan is given, the whole membership are
 * created in one transaction: a member numbered from a counter that then fails
 * to save would burn that number, and a half-registered member is worse than a
 * rejected one.
 */
export const create = async (
  req: AuthedRequest<Record<string, string>, unknown, CreateMemberBody>,
  res: Response,
): Promise<void> => {
  const { planId, startDate, ...fields } = req.body;
  try {
    if (planId) {
      const plan = await prisma.membershipPlan.findFirst({
        where: { id: planId, gymId: req.gymId },
      });
      if (!plan) {
        res.status(404).json({ error: 'Membership plan not found' });
        return;
      }
      if (!plan.isActive) {
        res.status(400).json({ error: 'That membership plan is no longer offered' });
        return;
      }
    }

    const member = await prisma.$transaction(async (tx) => {
      // Incrementing and reading back in one statement is what makes two
      // receptionists adding members at the same moment safe.
      const gym = await tx.gym.update({
        where: { id: req.gymId },
        data: { memberSeq: { increment: 1 } },
        select: { memberSeq: true },
      });

      const created = await tx.member.create({
        data: {
          gymId: req.gymId,
          memberNo: formatMemberNo(gym.memberSeq),
          ...fields,
        },
        select: memberFields,
      });

      if (planId) {
        const plan = await tx.membershipPlan.findUniqueOrThrow({ where: { id: planId } });
        const start = startDate ?? new Date();
        const expiry = addDays(start, plan.durationDays);

        await tx.membership.create({
          data: {
            gymId: req.gymId,
            memberId: created.id,
            planId: plan.id,
            startDate: start,
            expiryDate: expiry,
            originalExpiryDate: expiry,
            pricePaid: plan.price,
          },
        });
      }

      return created;
    });

    const full = await prisma.member.findUniqueOrThrow({
      where: { id: member.id },
      select: selectMember,
    });
    const view = decorate(full);

    await audit(req, {
      action: 'member.create',
      entity: 'member',
      entityId: member.id,
      entityLabel: `${member.memberNo} · ${member.name}`,
      after: { ...member, membership: view.currentMembership },
    });

    res.status(201).json(view);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/** Fields worth recording a change to. Photos are excluded — "photo changed"
 *  is noise, and the data-URL itself must never reach an audit row. */
const AUDITED_MEMBER_FIELDS = [
  'name', 'email', 'phone', 'gender', 'dateOfBirth', 'address',
  'emergencyContact', 'status',
] as const;

export const update = async (
  req: AuthedRequest<IdParam, unknown, UpdateMemberBody>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  const { name, email, phone, photo, gender, dateOfBirth, address, emergencyContact } = req.body;
  try {
    const existing = await prisma.member.findFirst({
      where: { id, gymId: req.gymId },
      select: memberFields,
    });
    if (!existing) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    await prisma.member.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(email !== undefined && { email }),
        ...(phone !== undefined && { phone }),
        ...(photo !== undefined && { photo }),
        ...(gender !== undefined && { gender }),
        ...(dateOfBirth !== undefined && { dateOfBirth }),
        ...(address !== undefined && { address }),
        ...(emergencyContact !== undefined && { emergencyContact }),
      },
    });

    const full = await prisma.member.findUniqueOrThrow({
      where: { id },
      select: selectMember,
    });

    // A save that changed nothing should not leave an entry claiming it did.
    const changed = diff(existing, full, AUDITED_MEMBER_FIELDS);
    if (changed) {
      await audit(req, {
        action: 'member.update',
        entity: 'member',
        entityId: id,
        entityLabel: `${existing.memberNo} · ${full.name}`,
        ...changed,
      });
    }

    res.json(decorate(full));
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
    const existing = await prisma.member.findFirst({
      where: { id, gymId: req.gymId },
      select: memberFields,
    });
    if (!existing) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    // Every relation is ON DELETE RESTRICT, so children go first. The counts
    // go into the audit entry: how much history went with the member is the
    // part worth knowing afterwards.
    const removed = await prisma.$transaction(async (tx) => {
      const [memberPlans, attendance, payments, memberships] = await Promise.all([
        tx.memberPlan.deleteMany({ where: { memberId: id } }),
        tx.attendance.deleteMany({ where: { memberId: id } }),
        tx.payment.deleteMany({ where: { memberId: id } }),
        tx.membership.deleteMany({ where: { memberId: id } }),
      ]);
      await tx.member.delete({ where: { id } });
      return {
        memberPlans: memberPlans.count,
        attendance: attendance.count,
        payments: payments.count,
        memberships: memberships.count,
      };
    });

    await audit(req, {
      action: 'member.delete',
      entity: 'member',
      entityId: id,
      entityLabel: `${existing.memberNo} · ${existing.name}`,
      before: { ...existing, deletedWith: removed },
    });

    res.json({ message: 'Member deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
