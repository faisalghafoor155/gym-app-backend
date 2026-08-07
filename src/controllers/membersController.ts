import type { Response } from 'express';
import type { Prisma } from '@prisma/client';
import prisma from '../db.js';
import { audit, diff } from '../services/audit.js';
import {
  addDays, currentMembershipWhere, effectiveMemberStatus, formatMemberNo,
  toView, withPlan,
} from '../services/membership.js';
import type { AuthedRequest } from '../types.js';
import type { CreateMemberBody, UpdateMemberBody, IdParam } from '../schemas.js';

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

export const getAll = async (req: AuthedRequest, res: Response): Promise<void> => {
  try {
    const members = await prisma.member.findMany({
      where: { gymId: req.gymId },
      select: selectMember,
      orderBy: { createdAt: 'desc' },
    });
    // One clock for the whole list, so two rows in the same response can never
    // disagree about what "today" was.
    const now = new Date();
    res.json(members.map(m => decorate(m, now)));
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
