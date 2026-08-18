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
  /**
   * What the front desk actually agreed with the member, if anything.
   *
   * Wins over both defaults, because personal training is negotiated: the
   * price list says 10,000, the member argues it down to 8,000, and the figure
   * that has to reach the books is the one they shook hands on. Null or
   * undefined falls through to the defaults, so the common case still needs no
   * typing — and an explicit 0 is a real decision to charge nothing.
   */
  override?: number | null,
): Prisma.Decimal =>
  override == null ? trainer.ptFee ?? gym.defaultPtFee : new Prisma.Decimal(override);

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
  override?: number | null,
): Prisma.PaymentUncheckedCreateInput | null => {
  const amount = resolvePtFee(trainer, gym, override);
  if (amount.lessThanOrEqualTo(0)) return null;

  // A negotiated price is worth saying so on the receipt: six months later,
  // "why did this member pay 8,000 when the rate is 10,000?" is a question
  // somebody will ask, and the answer should be on the row itself.
  const negotiated = override != null && !amount.equals(trainer.ptFee ?? gym.defaultPtFee);

  return {
    gymId,
    memberId,
    amount,
    status: 'due',
    method: 'cash',
    type: 'other',
    notes:
      `Trainer Fee (PT) for instructor: ${trainer.name}` +
      (negotiated ? ' (agreed rate)' : ''),
  };
};
