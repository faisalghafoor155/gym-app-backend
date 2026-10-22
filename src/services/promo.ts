import type { Prisma, PromoCode } from '@prisma/client';
import { toNumber } from './money.js';

/**
 * Promo codes: looking one up, pricing with it, and spending one use of it.
 *
 * Everything runs on the server and inside the sale's transaction. The code
 * decides the price, so a desk cannot type an "Eid discount" that no code
 * grants; and the use is spent in the same transaction as the membership it
 * discounted, so a failed sale never burns a limited code.
 */

/** A code that cannot be used now, with the reason in the desk's words. */
export class PromoError extends Error {}

/** Codes are kept upper-case, so "eid25" and "EID25" are one code. */
export const normaliseCode = (code: string): string => code.trim().toUpperCase();

/** The code, if it exists in this gym and can be used right now. */
export const findUsablePromo = async (
  tx: Prisma.TransactionClient,
  gymId: string,
  code: string,
  now: Date = new Date(),
): Promise<PromoCode> => {
  const promo = await tx.promoCode.findUnique({
    where: { gymId_code: { gymId, code: normaliseCode(code) } },
  });
  if (!promo) throw new PromoError('That promo code does not exist');
  if (!promo.isActive) throw new PromoError('That promo code has been switched off');
  if (promo.validFrom && promo.validFrom > now) throw new PromoError('That promo code is not valid yet');
  if (promo.validUntil && promo.validUntil < now) throw new PromoError('That promo code has expired');
  if (promo.maxUses != null && promo.usedCount >= promo.maxUses) {
    throw new PromoError('That promo code has been used up');
  }
  return promo;
};

/**
 * Rupees off `price`. A percentage is rounded to the whole rupee, since
 * nobody hands over paisas at a gym counter; a fixed amount never takes the
 * price below zero.
 */
export const discountFor = (promo: Pick<PromoCode, 'kind' | 'value'>, price: number): number => {
  const value = toNumber(promo.value) ?? 0;
  const off = promo.kind === 'percent' ? Math.round((price * value) / 100) : value;
  return Math.min(price, Math.max(0, off));
};

/**
 * Spends one use and records what it discounted.
 *
 * The guarded update is what makes a limited code safe at a busy counter: two
 * desks redeeming the last use at once both pass `findUsablePromo`, and only
 * one of them gets past this.
 */
export const redeemPromo = async (
  tx: Prisma.TransactionClient,
  promo: PromoCode,
  use: { gymId: string; memberId: string; membershipId: string; discount: number },
): Promise<void> => {
  const { count } = await tx.promoCode.updateMany({
    where: {
      id: promo.id,
      ...(promo.maxUses != null && { usedCount: { lt: promo.maxUses } }),
    },
    data: { usedCount: { increment: 1 } },
  });
  if (count === 0) throw new PromoError('That promo code has been used up');
  await tx.promoRedemption.create({
    data: { promoCodeId: promo.id, ...use },
  });
};
