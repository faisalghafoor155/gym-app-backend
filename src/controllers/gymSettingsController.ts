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

const gymSettingsFields = {
  name: true,
  ownerName: true,
  phone: true,
  address: true,
  logo: true,
  defaultPtFee: true,
  joiningFee: true,
  easypaisaAccount: true,
  jazzcashAccount: true,
  bankAccount: true,
  referralRewardDays: true,
  inactivityDays: true,
} as const;

/** What an owner can change here, and what a change is worth logging. */
const AUDITED_SETTINGS = [
  'name',
  'ownerName',
  'phone',
  'address',
  'logo',
  'defaultPtFee',
  'joiningFee',
  'easypaisaAccount',
  'jazzcashAccount',
  'bankAccount',
  'referralRewardDays',
  'inactivityDays',
] as const;

export const get = async (req: AuthedRequest, res: Response): Promise<void> => {
  try {
    const gym = await prisma.gym.findUniqueOrThrow({
      where: { id: req.gymId },
      select: gymSettingsFields,
    });
    res.json({
      ...gym,
      defaultPtFee: toNumber(gym.defaultPtFee),
      joiningFee: toNumber(gym.joiningFee),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const update = async (
  req: AuthedRequest<unknown, unknown, UpdateGymSettingsBody>,
  res: Response,
): Promise<void> => {
  const {
    name,
    ownerName,
    phone,
    address,
    logo,
    defaultPtFee,
    joiningFee,
    easypaisaAccount,
    jazzcashAccount,
    bankAccount,
    referralRewardDays,
    inactivityDays,
  } = req.body;
  try {
    const before = await prisma.gym.findUniqueOrThrow({
      where: { id: req.gymId },
      select: gymSettingsFields,
    });

    const after = await prisma.gym.update({
      where: { id: req.gymId },
      data: {
        // Undefined leaves the stored value alone; null clears it. A partial
        // save must not wipe the fields it did not mention.
        //
        // The gym's own name and owner are editable here for the first time.
        // They were set once at signup and never again, which meant a typo in
        // the name a member reads on every receipt could only be fixed in the
        // database. They are not nullable, so blank is refused by the schema
        // rather than clearing them.
        ...(name !== undefined && { name }),
        ...(ownerName !== undefined && { ownerName }),
        ...(phone !== undefined && { phone }),
        ...(address !== undefined && { address }),
        ...(logo !== undefined && { logo }),
        // Required by the schema, so always present — unlike the rest.
        defaultPtFee,
        ...(joiningFee !== undefined && { joiningFee }),
        ...(easypaisaAccount !== undefined && { easypaisaAccount }),
        ...(jazzcashAccount !== undefined && { jazzcashAccount }),
        ...(bankAccount !== undefined && { bankAccount }),
        ...(referralRewardDays !== undefined && { referralRewardDays }),
        ...(inactivityDays !== undefined && { inactivityDays }),
      },
      select: gymSettingsFields,
    });

    // Worth a trail: the fee silently alters what every future trainer
    // assignment bills, and an account number is where the gym's money is told
    // to go — changing it unnoticed is how takings end up in the wrong hands.
    // `diff` keeps a no-op save out of the log.
    const changed = diff(before, after, AUDITED_SETTINGS);
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

    res.json({
      ...after,
      defaultPtFee: toNumber(after.defaultPtFee),
      joiningFee: toNumber(after.joiningFee),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
