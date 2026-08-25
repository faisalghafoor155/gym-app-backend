import type { Response } from 'express';
import prisma from '../db.js';
import { audit } from '../services/audit.js';
import { addDays, renewalStart, toView, withPlan } from '../services/membership.js';
import type { AuthedRequest } from '../types.js';
import type {
  CreateMembershipBody, RenewMembershipBody, IdParam, MembershipParams,
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
 * Renews a membership: sells the next period and takes the money for it in one
 * go.
 *
 * Never automatic. A membership runs out and simply reads as expired until
 * somebody at the desk collects the fee and presses the button — the gym is
 * paid before the days are granted, not after, and nothing renews itself
 * behind the front desk's back.
 *
 * The new period starts the day after the old one ended, so a member renewing
 * with days still on the clock keeps them. Once the old membership has already
 * lapsed there is nothing left to carry, and the new period starts today
 * rather than backdating into a gap the member did not pay for.
 */
export const renew = async (
  req: AuthedRequest<MembershipParams, unknown, RenewMembershipBody>,
  res: Response,
): Promise<void> => {
  const { id: memberId, membershipId } = req.params;
  const { planId, amount, method, channel, reference } = req.body;
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

    // Superseded and cancelled memberships are closed history. Renewing from
    // one would either resurrect a membership somebody deliberately called
    // off, or branch a second live membership off a row a newer one already
    // replaced.
    if (membership.status === 'superseded' || membership.status === 'cancelled') {
      res.status(400).json({ error: 'That membership can no longer be renewed' });
      return;
    }

    // Renewing onto a different plan is normal — a member moving from monthly
    // to annual renews rather than starting again. Absent, it is the same plan
    // again, which is looked up in full rather than reused from the row above:
    // that one carries only the name and duration the view needs.
    const plan = await prisma.membershipPlan.findFirst({
      where: { id: planId ?? membership.planId, gymId: req.gymId },
    });
    if (!plan) {
      res.status(404).json({ error: 'Membership plan not found' });
      return;
    }
    // Only checked when the front desk names a plan. A retired plan must not
    // strand the members already on it: renewing onto the same thing they
    // already hold is continuing what they bought, not buying something the
    // gym stopped selling.
    if (planId && planId !== membership.planId && !plan.isActive) {
      res.status(400).json({ error: 'That membership plan is no longer offered' });
      return;
    }

    const start = renewalStart(membership.expiryDate);
    const expiry = addDays(start, plan.durationDays);

    const { created, payment } = await prisma.$transaction(async (tx) => {
      // The old membership steps aside rather than being edited: two rows is
      // what makes "what did this member buy, and when" answerable later.
      await tx.membership.update({
        where: { id: membership.id },
        data: { status: 'superseded' },
      });

      const next = await tx.membership.create({
        data: {
          gymId: req.gymId,
          memberId,
          planId: plan.id,
          startDate: start,
          expiryDate: expiry,
          // Snapshotted so a later price change cannot rewrite what this
          // member was actually charged.
          pricePaid: plan.price,
        },
        include: withPlan,
      });

      // Written in the same transaction as the membership it bought. A renewal
      // that granted the days but lost the receipt would leave the gym's books
      // claiming it was never paid.
      const receipt = await tx.payment.create({
        data: {
          gymId: req.gymId,
          memberId,
          membershipId: next.id,
          amount,
          method,
          channel: method === 'cash' ? null : channel ?? null,
          reference: reference ?? null,
          status: 'paid',
          type: 'membership',
          recordedById: req.userId,
          notes: `Renewal — ${plan.name}`,
        },
      });

      return { created: next, payment: receipt };
    });

    await audit(req, {
      action: 'membership.renew',
      entity: 'membership',
      entityId: created.id,
      entityLabel: `${membership.member.memberNo} · ${membership.member.name} · ${plan.name}`,
      before: {
        membershipId: membership.id,
        planName: membership.plan.name,
        expiryDate: membership.expiryDate,
      },
      after: {
        membershipId: created.id,
        planName: plan.name,
        startDate: start,
        expiryDate: expiry,
        pricePaid: plan.price,
        paymentId: payment.id,
        amountPaid: amount,
        method,
        ...(payment.channel && { channel: payment.channel }),
      },
    });

    res.status(201).json(toView(created));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Moving a membership between the states the desk controls by hand.
 *
 * Suspending does not move the expiry date: the days keep running while the
 * membership is paused. That is the gym's call to make at the counter — a
 * member who is owed the time back gets it by renewing from a date the desk
 * chooses, rather than by the app silently rewriting what they bought.
 *
 * Cancelling leaves every payment where it is. The money was taken, and the
 * books have to keep saying so; refunding is a separate act with its own
 * endpoint and its own audit entry.
 */
const setStatus = async (
  req: AuthedRequest<MembershipParams>,
  res: Response,
  to: 'suspended' | 'active' | 'cancelled',
  action: string,
): Promise<void> => {
  const { id: memberId, membershipId } = req.params;
  try {
    // Scoped by member and gym as well as id, so another gym's membership
    // reads as missing rather than as forbidden.
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

    // Superseded and cancelled memberships are closed history. Reopening one
    // would either resurrect something deliberately called off, or put a
    // second live membership beside the one that already replaced it.
    if (membership.status === 'superseded' || membership.status === 'cancelled') {
      res.status(400).json({ error: 'That membership can no longer be changed' });
      return;
    }

    // Resuming is only meaningful for something actually suspended, and
    // suspending something already suspended is a no-op the desk should be
    // told about rather than silently accept.
    if (to === 'active' && membership.status !== 'suspended') {
      res.status(400).json({ error: 'That membership is not suspended' });
      return;
    }
    if (to === 'suspended' && membership.status === 'suspended') {
      res.status(400).json({ error: 'That membership is already suspended' });
      return;
    }

    const updated = await prisma.membership.update({
      where: { id: membership.id },
      data: { status: to },
      include: withPlan,
    });

    await audit(req, {
      action,
      entity: 'membership',
      entityId: membership.id,
      entityLabel: `${membership.member.memberNo} · ${membership.member.name} · ${membership.plan.name}`,
      before: { status: membership.status, expiryDate: membership.expiryDate },
      after: { status: to, expiryDate: updated.expiryDate },
    });

    res.json(toView(updated));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/** Pause a membership. The expiry date keeps running. */
export const suspend = async (
  req: AuthedRequest<MembershipParams>,
  res: Response,
): Promise<void> => setStatus(req, res, 'suspended', 'membership.suspend');

/** Put a suspended membership back into service. */
export const resume = async (
  req: AuthedRequest<MembershipParams>,
  res: Response,
): Promise<void> => setStatus(req, res, 'active', 'membership.resume');

/** Call a membership off for good. Payments are left untouched. */
export const cancel = async (
  req: AuthedRequest<MembershipParams>,
  res: Response,
): Promise<void> => setStatus(req, res, 'cancelled', 'membership.cancel');
