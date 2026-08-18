import type { Response } from 'express';
import prisma from '../db.js';
import { audit, diff } from '../services/audit.js';
import { toNumber } from '../services/money.js';
import type { AuthedRequest } from '../types.js';
import type { UpdateGymSettingsBody } from '../schemas.js';

/**
 * Gym-wide settings — the prices and rules that are not a plan or a product.
 *
 * Small on purpose: this exists because the personal-trainer fee was a literal
 * `10000` compiled into the member controller, which meant no gym could charge
 * anything else. Settings that belong to a member, a plan or a trainer stay
 * on those rows; this is only for what is genuinely gym-wide.
 */

export const get = async (req: AuthedRequest, res: Response): Promise<void> => {
  try {
    const gym = await prisma.gym.findUniqueOrThrow({
      where: { id: req.gymId },
      select: { name: true, ownerName: true, phone: true, defaultPtFee: true },
    });
    res.json({ ...gym, defaultPtFee: toNumber(gym.defaultPtFee) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const update = async (
  req: AuthedRequest<unknown, unknown, UpdateGymSettingsBody>,
  res: Response,
): Promise<void> => {
  const { defaultPtFee } = req.body;
  try {
    const before = await prisma.gym.findUniqueOrThrow({
      where: { id: req.gymId },
      select: { defaultPtFee: true },
    });

    const after = await prisma.gym.update({
      where: { id: req.gymId },
      data: { defaultPtFee },
      select: { name: true, ownerName: true, phone: true, defaultPtFee: true },
    });

    // A price change is worth a trail — it silently alters what every future
    // trainer assignment bills. `diff` keeps a no-op save out of the log.
    const changed = diff(before, { defaultPtFee: after.defaultPtFee }, ['defaultPtFee']);
    if (changed) {
      await audit(req, {
        action: 'gym.settingsUpdate',
        entity: 'gym',
        entityId: req.gymId,
        entityLabel: after.name,
        before: changed.before,
        after: changed.after,
      });
    }

    res.json({ ...after, defaultPtFee: toNumber(after.defaultPtFee) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
