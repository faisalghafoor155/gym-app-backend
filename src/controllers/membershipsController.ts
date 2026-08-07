import type { Response } from 'express';
import prisma from '../db.js';
import { audit } from '../services/audit.js';
import { addDays, toView, withPlan } from '../services/membership.js';
import type { AuthedRequest } from '../types.js';
import type { CreateMembershipBody, IdParam } from '../schemas.js';

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
