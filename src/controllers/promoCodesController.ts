import type { Response } from 'express';
import { Prisma, type PromoCode } from '@prisma/client';
import prisma from '../db.js';
import { audit, diff } from '../services/audit.js';
import { withMoney } from '../services/money.js';
import { discountFor, findUsablePromo, PromoError } from '../services/promo.js';
import type { AuthedRequest } from '../types.js';
import type {
  CheckPromoQuery, CreatePromoCodeBody, IdParam, UpdatePromoCodeBody,
} from '../schemas.js';

/**
 * Discount codes the desk can apply when selling a membership — FAMILY10,
 * STUDENT, EID25. The code is applied by the server at sale time; these
 * routes only manage the list and answer "would this one work?".
 */

const toView = (p: PromoCode & { _count?: { redemptions: number } }) => {
  const { _count, ...rest } = p;
  return { ...withMoney(rest, 'value'), redemptions: _count?.redemptions ?? 0 };
};

export const getAll = async (req: AuthedRequest, res: Response): Promise<void> => {
  try {
    const codes = await prisma.promoCode.findMany({
      where: { gymId: req.gymId },
      include: { _count: { select: { redemptions: true } } },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    });
    // Total discount given per code, so an owner can see what an offer cost.
    const totals = await prisma.promoRedemption.groupBy({
      by: ['promoCodeId'],
      where: { gymId: req.gymId },
      _sum: { discount: true },
    });
    res.json({
      data: codes.map(c => ({
        ...toView(c),
        totalDiscount: totals.find(t => t.promoCodeId === c.id)?._sum.discount?.toNumber() ?? 0,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

const isDuplicate = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

export const create = async (
  req: AuthedRequest<Record<string, string>, unknown, CreatePromoCodeBody>,
  res: Response,
): Promise<void> => {
  const { code, description, kind, value, validFrom, validUntil, maxUses, isActive } = req.body;
  try {
    const promo = await prisma.promoCode.create({
      data: {
        gymId: req.gymId,
        code,
        description: description ?? null,
        kind,
        value,
        validFrom: validFrom ?? null,
        validUntil: validUntil ?? null,
        maxUses: maxUses ?? null,
        isActive: isActive ?? true,
      },
    });
    await audit(req, {
      action: 'promo.create',
      entity: 'promoCode',
      entityId: promo.id,
      entityLabel: promo.code,
      after: { code, kind, value, validFrom, validUntil, maxUses },
    });
    res.status(201).json(toView(promo));
  } catch (err) {
    if (isDuplicate(err)) {
      res.status(409).json({ error: 'A promo code with that name already exists' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const update = async (
  req: AuthedRequest<IdParam, unknown, UpdatePromoCodeBody>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  try {
    const existing = await prisma.promoCode.findFirst({ where: { id, gymId: req.gymId } });
    if (!existing) {
      res.status(404).json({ error: 'Promo code not found' });
      return;
    }
    const b = req.body;
    // A percent code edited to a percent over 100 is caught by the schema
    // only when both fields arrive together; check the combination here.
    const kind = b.kind ?? existing.kind;
    const value = b.value ?? existing.value.toNumber();
    if (kind === 'percent' && value > 100) {
      res.status(400).json({ error: 'A percentage cannot be more than 100' });
      return;
    }
    const updated = await prisma.promoCode.update({
      where: { id },
      data: {
        ...(b.code !== undefined && { code: b.code }),
        ...(b.description !== undefined && { description: b.description }),
        ...(b.kind !== undefined && { kind: b.kind }),
        ...(b.value !== undefined && { value: b.value }),
        ...(b.validFrom !== undefined && { validFrom: b.validFrom }),
        ...(b.validUntil !== undefined && { validUntil: b.validUntil }),
        ...(b.maxUses !== undefined && { maxUses: b.maxUses }),
        ...(b.isActive !== undefined && { isActive: b.isActive }),
      },
    });
    const changed = diff(existing, updated, [
      'code', 'description', 'kind', 'value', 'validFrom', 'validUntil', 'maxUses', 'isActive',
    ]);
    if (changed) {
      await audit(req, {
        action: 'promo.update',
        entity: 'promoCode',
        entityId: id,
        entityLabel: updated.code,
        before: changed.before,
        after: changed.after,
      });
    }
    res.json(toView(updated));
  } catch (err) {
    if (isDuplicate(err)) {
      res.status(409).json({ error: 'A promo code with that name already exists' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Deletes a code nobody has used, or switches off one that has been: its
 * redemptions are the record of what each discounted membership was sold
 * for, and deleting them would leave those prices unexplained.
 */
export const remove = async (req: AuthedRequest<IdParam>, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    const existing = await prisma.promoCode.findFirst({
      where: { id, gymId: req.gymId },
      include: { _count: { select: { redemptions: true } } },
    });
    if (!existing) {
      res.status(404).json({ error: 'Promo code not found' });
      return;
    }
    if (existing._count.redemptions > 0) {
      await prisma.promoCode.update({ where: { id }, data: { isActive: false } });
      await audit(req, {
        action: 'promo.deactivate',
        entity: 'promoCode',
        entityId: id,
        entityLabel: existing.code,
        before: { isActive: existing.isActive },
        after: { isActive: false },
      });
      res.json({ deactivated: true });
      return;
    }
    await prisma.promoCode.delete({ where: { id } });
    await audit(req, {
      action: 'promo.delete',
      entity: 'promoCode',
      entityId: id,
      entityLabel: existing.code,
      before: { code: existing.code, kind: existing.kind, value: existing.value },
    });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/** What a code would take off a plan, without spending a use of it. */
export const check = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, CheckPromoQuery>,
  res: Response,
): Promise<void> => {
  const { code, planId } = req.query;
  try {
    const plan = await prisma.membershipPlan.findFirst({ where: { id: planId, gymId: req.gymId } });
    if (!plan) {
      res.status(404).json({ error: 'Membership plan not found' });
      return;
    }
    const promo = await findUsablePromo(prisma, req.gymId, code);
    const price = plan.price.toNumber();
    const discount = discountFor(promo, price);
    res.json({
      code: promo.code,
      description: promo.description,
      kind: promo.kind,
      value: promo.value.toNumber(),
      price,
      discount,
      finalPrice: price - discount,
    });
  } catch (err) {
    if (err instanceof PromoError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
