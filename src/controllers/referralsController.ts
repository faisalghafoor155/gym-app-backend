import type { Response } from 'express';
import prisma from '../db.js';
import { audit } from '../services/audit.js';
import { addDays, currentMembershipWhere, startOfDay } from '../services/membership.js';
import type { AuthedRequest } from '../types.js';
import type { GrantReferralBody, IdParam, ReferralQuery } from '../schemas.js';

/**
 * Members who brought friends in, and the rewards that earned them.
 *
 * A referral is recorded when the friend registers naming who sent them; the
 * reward is granted afterwards by somebody at the desk, so a gym can wait to
 * see the friend actually pay and train before giving anything away.
 */

const memberSummary = { select: { id: true, name: true, memberNo: true, phone: true } } as const;

export const getAll = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, ReferralQuery>,
  res: Response,
): Promise<void> => {
  const { status } = req.query;
  try {
    const [rows, byStatus, top] = await Promise.all([
      prisma.referralReward.findMany({
        where: { gymId: req.gymId, ...(status && { status }) },
        include: {
          referrer: memberSummary,
          referred: { select: { id: true, name: true, memberNo: true, createdAt: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      prisma.referralReward.groupBy({
        by: ['status'],
        where: { gymId: req.gymId },
        _count: { _all: true },
      }),
      // The leaderboard: who has brought in the most friends, ever.
      prisma.referralReward.groupBy({
        by: ['referrerId'],
        where: { gymId: req.gymId, status: { not: 'cancelled' } },
        _count: { _all: true },
        orderBy: { _count: { referrerId: 'desc' } },
        take: 5,
      }),
    ]);

    const topMembers = await prisma.member.findMany({
      where: { id: { in: top.map(t => t.referrerId) } },
      select: { id: true, name: true, memberNo: true },
    });

    res.json({
      data: rows,
      counts: Object.fromEntries(
        (['pending', 'granted', 'cancelled'] as const).map(s => [
          s, byStatus.find(b => b.status === s)?._count._all ?? 0,
        ]),
      ),
      topReferrers: top.map(t => ({
        member: topMembers.find(m => m.id === t.referrerId) ?? null,
        referrals: t._count._all,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

const findReward = (gymId: string, id: string) =>
  prisma.referralReward.findFirst({
    where: { id, gymId },
    include: { referrer: { select: { id: true, name: true, memberNo: true } }, referred: { select: { name: true } } },
  });

/**
 * Gives the referrer their reward.
 *
 * Free days go onto the referrer's running membership, moving its expiry the
 * way a freeze does — with the row and an audit entry to say why. A referrer
 * with nothing running cannot be given days; the desk can still mark the
 * reward given with a note saying what they got instead.
 */
export const grant = async (
  req: AuthedRequest<IdParam, unknown, GrantReferralBody>,
  res: Response,
): Promise<void> => {
  const { note } = req.body;
  try {
    const reward = await findReward(req.gymId, req.params.id);
    if (!reward) {
      res.status(404).json({ error: 'Referral not found' });
      return;
    }
    if (reward.status !== 'pending') {
      res.status(400).json({ error: `That reward has already been ${reward.status}` });
      return;
    }

    let membership: { id: string; expiryDate: Date } | null = null;
    if (reward.rewardDays > 0) {
      membership = await prisma.membership.findFirst({
        where: { memberId: reward.referrerId, gymId: req.gymId, ...currentMembershipWhere, status: 'active' },
        orderBy: { startDate: 'desc' },
        select: { id: true, expiryDate: true },
      });
      if (!membership || membership.expiryDate < startOfDay(new Date())) {
        if (!note) {
          res.status(400).json({
            error: `${reward.referrer.name} has no running membership to add ${reward.rewardDays} days to. ` +
              'Renew them first, or write what they were given instead.',
          });
          return;
        }
        membership = null;
      }
    }

    const newExpiry = membership ? addDays(membership.expiryDate, reward.rewardDays) : null;

    const updated = await prisma.$transaction(async (tx) => {
      if (membership && newExpiry) {
        await tx.membership.update({ where: { id: membership.id }, data: { expiryDate: newExpiry } });
      }
      return tx.referralReward.update({
        where: { id: reward.id },
        data: {
          status: 'granted',
          note: note ?? null,
          membershipId: membership?.id ?? null,
          grantedAt: new Date(),
          grantedById: req.userId,
        },
      });
    });

    await audit(req, {
      action: 'referral.grant',
      entity: 'referral',
      entityId: reward.id,
      entityLabel: `${reward.referrer.memberNo} · ${reward.referrer.name} ← ${reward.referred.name}`,
      before: { status: 'pending', ...(membership && { expiryDate: membership.expiryDate }) },
      after: {
        status: 'granted',
        ...(newExpiry && { expiryDate: newExpiry, daysAdded: reward.rewardDays }),
        ...(note && { note }),
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const cancel = async (req: AuthedRequest<IdParam>, res: Response): Promise<void> => {
  try {
    const reward = await findReward(req.gymId, req.params.id);
    if (!reward) {
      res.status(404).json({ error: 'Referral not found' });
      return;
    }
    if (reward.status !== 'pending') {
      res.status(400).json({ error: `That reward has already been ${reward.status}` });
      return;
    }
    const updated = await prisma.referralReward.update({
      where: { id: reward.id },
      data: { status: 'cancelled' },
    });
    await audit(req, {
      action: 'referral.cancel',
      entity: 'referral',
      entityId: reward.id,
      entityLabel: `${reward.referrer.memberNo} · ${reward.referrer.name} ← ${reward.referred.name}`,
      before: { status: 'pending' },
      after: { status: 'cancelled' },
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
