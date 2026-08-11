import type { Response } from 'express';
import prisma from '../db.js';
import { audit, diff } from '../services/audit.js';
import { withMoney } from '../services/money.js';
import type { AuthedRequest } from '../types.js';
import type {
  CreateMembershipPlanBody, UpdateMembershipPlanBody, MembershipPlanQuery, IdParam,
} from '../schemas.js';

export const getAll = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, MembershipPlanQuery>,
  res: Response,
): Promise<void> => {
  try {
    const plans = await prisma.membershipPlan.findMany({
      where: {
        gymId: req.gymId,
        ...(req.query.includeInactive ? {} : { isActive: true }),
      },
      // Offered plans first, then retired ones, cheapest first within each.
      orderBy: [{ isActive: 'desc' }, { durationDays: 'asc' }],
    });
    res.json(plans.map(p => withMoney(p, 'price')));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const create = async (
  req: AuthedRequest<Record<string, string>, unknown, CreateMembershipPlanBody>,
  res: Response,
): Promise<void> => {
  const { name, price, durationDays, isActive } = req.body;
  try {
    const plan = await prisma.membershipPlan.create({
      data: { gymId: req.gymId, name, price, durationDays, isActive: isActive ?? true },
    });

    await audit(req, {
      action: 'plan.create',
      entity: 'membershipPlan',
      entityId: plan.id,
      entityLabel: plan.name,
      after: { name, price, durationDays },
    });

    res.status(201).json(withMoney(plan, 'price'));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

const AUDITED_PLAN_FIELDS = ['name', 'price', 'durationDays', 'isActive'] as const;

/**
 * Edits the price list. Memberships already sold keep the price and duration
 * they were sold at — those are snapshotted onto each Membership row — so this
 * only ever affects what happens next.
 */
export const update = async (
  req: AuthedRequest<IdParam, unknown, UpdateMembershipPlanBody>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  const { name, price, durationDays, isActive } = req.body;
  try {
    const existing = await prisma.membershipPlan.findFirst({
      where: { id, gymId: req.gymId },
    });
    if (!existing) {
      res.status(404).json({ error: 'Membership plan not found' });
      return;
    }

    const plan = await prisma.membershipPlan.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(price !== undefined && { price }),
        ...(durationDays !== undefined && { durationDays }),
        ...(isActive !== undefined && { isActive }),
      },
    });

    const changed = diff(existing, plan, AUDITED_PLAN_FIELDS);
    if (changed) {
      await audit(req, {
        action: 'plan.update',
        entity: 'membershipPlan',
        entityId: id,
        entityLabel: plan.name,
        ...changed,
      });
    }

    res.json(withMoney(plan, 'price'));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Retires a plan rather than deleting it. Memberships sold under it still
 * point at it, and their history has to keep resolving — so the plan stops
 * being offered and nothing else changes.
 */
export const deactivate = async (
  req: AuthedRequest<IdParam>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  try {
    const existing = await prisma.membershipPlan.findFirst({
      where: { id, gymId: req.gymId },
    });
    if (!existing) {
      res.status(404).json({ error: 'Membership plan not found' });
      return;
    }

    // Already retired: nothing to do, and no audit entry for a non-event.
    if (!existing.isActive) {
      res.json(withMoney(existing, 'price'));
      return;
    }

    const plan = await prisma.membershipPlan.update({
      where: { id },
      data: { isActive: false },
    });

    await audit(req, {
      action: 'plan.deactivate',
      entity: 'membershipPlan',
      entityId: id,
      entityLabel: plan.name,
      before: { isActive: true },
      after: { isActive: false },
    });

    res.json(withMoney(plan, 'price'));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
