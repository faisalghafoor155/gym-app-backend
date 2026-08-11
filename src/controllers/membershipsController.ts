import type { Response } from 'express';
import prisma from '../db.js';
import { audit } from '../services/audit.js';
import { addDays, toView, withPlan } from '../services/membership.js';
import type { AuthedRequest } from '../types.js';
import type {
  CreateMembershipBody, ExtendMembershipBody, IdParam, MembershipParams,
} from '../schemas.js';

/** Everything this member has ever bought, newest first. */
export const getHistory = async (
  req: AuthedRequest<IdParam>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  try {
    const member = await prisma.member.findFirst({
      where: { id, gymId: req.gymId },
      select: { id: true },
    });
    if (!member) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    const memberships = await prisma.membership.findMany({
      where: { memberId: id, gymId: req.gymId },
      include: withPlan,
      orderBy: { createdAt: 'desc' },
    });

    res.json(memberships.map(m => toView(m)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Sells a membership to a member.
 *
 * Any membership they already have is marked `superseded` in the same
 * transaction rather than edited or deleted — an upgrade halfway through a
 * month is a normal thing to do, and both rows are worth keeping.
 *
 * The expiry is derived from the plan's duration here on the server. The
 * request cannot supply one: an expiry date the front desk can type is an
 * expiry date the front desk can quietly extend, which is the whole reason
 * extensions are tracked separately.
 */
export const create = async (
  req: AuthedRequest<IdParam, unknown, CreateMembershipBody>,
  res: Response,
): Promise<void> => {
  const { id: memberId } = req.params;
  const { planId, startDate } = req.body;
  try {
    const member = await prisma.member.findFirst({
      where: { id: memberId, gymId: req.gymId },
      select: { id: true, name: true, memberNo: true },
    });
    if (!member) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    // MembershipPlan carries its own gymId, so this is what stops one gym
    // selling another gym's plan.
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

    const start = startDate ?? new Date();
    const expiry = addDays(start, plan.durationDays);

    const { membership, supersededCount } = await prisma.$transaction(async (tx) => {
      const superseded = await tx.membership.updateMany({
        where: {
          memberId,
          gymId: req.gymId,
          status: { notIn: ['superseded', 'cancelled'] },
        },
        data: { status: 'superseded' },
      });

      const created = await tx.membership.create({
        data: {
          gymId: req.gymId,
          memberId,
          planId: plan.id,
          startDate: start,
          expiryDate: expiry,
          originalExpiryDate: expiry,
          // Snapshotted so a later price change cannot rewrite what this
          // member was actually charged.
          pricePaid: plan.price,
        },
        include: withPlan,
      });

      return { membership: created, supersededCount: superseded.count };
    });

    await audit(req, {
      action: 'membership.create',
      entity: 'membership',
      entityId: membership.id,
      entityLabel: `${member.memberNo} · ${member.name} · ${plan.name}`,
      after: {
        planId: plan.id,
        planName: plan.name,
        startDate: start,
        expiryDate: expiry,
        pricePaid: plan.price,
        ...(supersededCount > 0 && { supersededPrevious: supersededCount }),
      },
    });

    res.status(201).json(toView(membership));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Grants extra days on a membership the member already has.
 *
 * This is the only route that moves an expiry date. Selling a membership
 * derives the expiry from the plan's duration and refuses a client-supplied
 * one, so every day a member has beyond what they paid for arrives through
 * here — with a reason, an actor and an audit row attached. That is what makes
 * `expiryDate - originalExpiryDate` a number the owner can trust.
 *
 * Owner-only, because free days are money.
 */
export const extend = async (
  req: AuthedRequest<MembershipParams, unknown, ExtendMembershipBody>,
  res: Response,
): Promise<void> => {
  const { id: memberId, membershipId } = req.params;
  const { days, reason } = req.body;
  try {
    // Scoped by member and gym as well as id: a valid membership id belonging
    // to somebody else must read as missing, not as forbidden.
    const membership = await prisma.membership.findFirst({
      where: { id: membershipId, memberId, gymId: req.gymId },
      include: {
        ...withPlan,
        member: { select: { name: true, memberNo: true } },
      },
    });
    if (!membership) {
      res.status(404).json({ error: 'Membership not found' });
      return;
    }

    // Superseded and cancelled memberships are closed history. Extending one
    // would either resurrect a membership somebody deliberately called off, or
    // move the expiry on a row that a newer membership has already replaced.
    if (membership.status === 'superseded' || membership.status === 'cancelled') {
      res.status(400).json({ error: 'That membership can no longer be extended' });
      return;
    }

    const newExpiry = addDays(membership.expiryDate, days);

    const updated = await prisma.membership.update({
      where: { id: membership.id },
      data: {
        expiryDate: newExpiry,
        // Accumulates, so the total granted across every extension stays
        // readable next to originalExpiryDate, which is never touched.
        extendedDays: { increment: days },
        extensionReason: reason,
        extendedBy: req.userId,
      },
      include: withPlan,
    });

    await audit(req, {
      action: 'membership.extend',
      entity: 'membership',
      entityId: membership.id,
      entityLabel: `${membership.member.memberNo} · ${membership.member.name} · ${membership.plan.name}`,
      before: {
        expiryDate: membership.expiryDate,
        extendedDays: membership.extendedDays,
      },
      after: {
        expiryDate: newExpiry,
        extendedDays: updated.extendedDays,
        days,
      },
      reason,
    });

    res.json(toView(updated));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
