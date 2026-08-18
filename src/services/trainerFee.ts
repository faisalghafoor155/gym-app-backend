import { Prisma } from '@prisma/client';

/**
 * What it costs to put a member with a personal trainer.
 *
 * The fee used to be the literal `10000` written twice in the member
 * controller — once for assignment at registration, once for assignment on
 * edit. Two copies of a price is one copy too many: changing it meant finding
 * both, and no gym could charge anything else.
 *
 * Resolution order is trainer, then gym. A null `ptFee` on the trainer means
 * "whatever the gym charges", not "free" — otherwise every trainer added
 * before the column existed would quietly become free.
 */
export const resolvePtFee = (
  trainer: { ptFee: Prisma.Decimal | null },
  gym: { defaultPtFee: Prisma.Decimal },
): Prisma.Decimal => trainer.ptFee ?? gym.defaultPtFee;

/** The `select` both callers need to resolve a fee. */
export const trainerFeeSelect = { id: true, name: true, ptFee: true } as const;

/**
 * Builds the due-payment row for a trainer assignment, or null when the fee
 * is zero.
 *
 * A zero-rupee "due" is not a debt — it would sit on the member's outstanding
 * list forever, and show up in the dashboard's follow-up count as money the
 * gym is owed. A gym that has not set a price should generate no charge at
 * all, which is why this returns null rather than a row for 0.00.
 */
export const buildPtFeeCharge = (
  gymId: string,
  memberId: string,
  trainer: { name: string; ptFee: Prisma.Decimal | null },
  gym: { defaultPtFee: Prisma.Decimal },
): Prisma.PaymentUncheckedCreateInput | null => {
  const amount = resolvePtFee(trainer, gym);
  if (amount.lessThanOrEqualTo(0)) return null;

  return {
    gymId,
    memberId,
    amount,
    status: 'due',
    method: 'cash',
    type: 'other',
    notes: `Trainer Fee (PT) for instructor: ${trainer.name}`,
  };
};
