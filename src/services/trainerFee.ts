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

/** What the front desk decided about this particular assignment. */
export interface PtFeeTerms {
  /** The negotiated amount, if it was haggled rather than taken from a rate. */
  override?: number | null;
  /**
   * Whether the money was handed over there and then.
   *
   * Defaults to false, which records a due. The alternative is not a cosmetic
   * difference: a fee left as due sits on the member's outstanding balance and
   * in the dashboard's "to chase" figure until somebody finds it on the
   * Payments page and settles it. When the cash was taken at the counter —
   * which at registration it usually is — saying so here is what keeps the
   * gym's books from claiming it is owed money it already has.
   */
  paid?: boolean;
  /** Who took it. Only meaningful when `paid`. */
  recordedById?: string;
}

/**
 * Builds the payment row for a trainer assignment, or null when the fee is
 * zero.
 *
 * A zero-rupee charge is not a debt and not a receipt — it would sit on the
 * member's outstanding list forever, and show up in the dashboard's follow-up
 * count as money the gym is owed. A gym that has not set a price should
 * generate no charge at all, which is why this returns null rather than a row
 * for 0.00.
 */
export const buildPtFeeCharge = (
  gymId: string,
  memberId: string,
  trainer: { name: string; ptFee: Prisma.Decimal | null },
  gym: { defaultPtFee: Prisma.Decimal },
  terms: PtFeeTerms = {},
): Prisma.PaymentUncheckedCreateInput | null => {
  const amount = resolvePtFee(trainer, gym, terms.override);
  if (amount.lessThanOrEqualTo(0)) return null;

  // A negotiated price is worth saying so on the receipt: six months later,
  // "why did this member pay 8,000 when the rate is 10,000?" is a question
  // somebody will ask, and the answer should be on the row itself.
  const negotiated =
    terms.override != null && !amount.equals(trainer.ptFee ?? gym.defaultPtFee);

  return {
    gymId,
    memberId,
    amount,
    status: terms.paid ? 'paid' : 'due',
    method: 'cash',
    type: 'other',
    // Attributed only when it was actually taken. A due has not been collected
    // by anyone yet, so naming whoever typed the form would misread as "this
    // person took the money".
    ...(terms.paid && terms.recordedById && { recordedById: terms.recordedById }),
    notes:
      `Trainer Fee (PT) for instructor: ${trainer.name}` +
      (negotiated ? ' (agreed rate)' : ''),
  };
};
