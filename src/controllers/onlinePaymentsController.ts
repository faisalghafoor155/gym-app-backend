import type { Response } from 'express';
import prisma from '../db.js';
import type { AuthedRequest } from '../types.js';
import { toView } from '../services/membership.js';

/**
 * Returns active membership plans for online purchase/renewal.
 */
export const getPlans = async (
  req: AuthedRequest,
  res: Response,
): Promise<void> => {
  try {
    const plans = await prisma.membershipPlan.findMany({
      where: { gymId: req.gymId, isActive: true },
      orderBy: { price: 'asc' },
    });
    res.json(plans);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Processes payment checkout for renewals or dues.
 */
export const checkout = async (
  req: AuthedRequest<unknown, unknown, { type: 'due' | 'renew'; planId?: string; paymentId?: string }>,
  res: Response,
): Promise<void> => {
  const { type, planId, paymentId } = req.body;
  const memberId = req.memberId;

  if (!memberId) {
    res.status(403).json({ error: 'Only members can checkout online' });
    return;
  }

  try {
    if (type === 'due') {
      if (!paymentId) {
        res.status(400).json({ error: 'paymentId is required for due payment' });
        return;
      }

      const payment = await prisma.payment.findFirst({
        where: { id: paymentId, memberId, status: 'due' },
      });

      if (!payment) {
        res.status(404).json({ error: 'Due payment record not found' });
        return;
      }

      // Reconcile / update payment in a transaction
      await prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: 'paid',
          method: 'online',
        },
      });

      res.json({ success: true, message: 'Dues paid successfully' });
      return;
    }

    if (type === 'renew') {
      if (!planId) {
        res.status(400).json({ error: 'planId is required for renewal' });
        return;
      }

      const plan = await prisma.membershipPlan.findFirst({
        where: { id: planId, gymId: req.gymId, isActive: true },
      });

      if (!plan) {
        res.status(404).json({ error: 'Membership plan not found' });
        return;
      }

      // Check current memberships to determine startDate
      const activeMemberships = await prisma.membership.findMany({
        where: { memberId, status: 'active' },
        orderBy: { expiryDate: 'desc' },
      });

      let startDate = new Date();
      if (activeMemberships.length > 0 && activeMemberships[0].expiryDate > new Date()) {
        // Chain the new membership after the current one expires
        startDate = new Date(activeMemberships[0].expiryDate);
      }

      const expiryDate = new Date(startDate);
      expiryDate.setDate(expiryDate.getDate() + plan.durationDays);

      // Create membership and payment in transaction
      const result = await prisma.$transaction(async (tx) => {
        const membership = await tx.membership.create({
          data: {
            gymId: req.gymId,
            memberId,
            planId,
            startDate,
            expiryDate,
            originalExpiryDate: expiryDate,
            pricePaid: plan.price,
            status: 'active',
          },
          include: {
            plan: true,
          },
        });

        const payment = await tx.payment.create({
          data: {
            gymId: req.gymId,
            memberId,
            amount: plan.price,
            status: 'paid',
            method: 'online',
            membershipId: membership.id,
            notes: `Online renewal for plan: ${plan.name}`,
          },
        });

        return { membership, payment };
      });

      res.status(201).json({
        success: true,
        message: 'Membership renewed successfully',
        membership: toView(result.membership),
      });
      return;
    }

    res.status(400).json({ error: 'Invalid checkout type' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Payment processing failed' });
  }
};
