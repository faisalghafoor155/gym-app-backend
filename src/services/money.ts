import { Prisma } from '@prisma/client';

/**
 * Money is stored as `Decimal(10,2)` rather than a float, because a gym's books
 * have to add up exactly and binary floating point cannot represent 0.1. That
 * makes arithmetic correct, but it changes two things at the edges:
 *
 *   - Prisma hands back a `Decimal` object, not a number.
 *   - `JSON.stringify` turns that into a *string*, so an untouched controller
 *     would quietly start sending `"2500"` where it used to send `2500`, and
 *     every `.toLocaleString()` in the UI would break.
 *
 * So Decimal is the storage and arithmetic type, and the API boundary still
 * speaks plain numbers. These helpers are that boundary — the conversion
 * happens once, on the way out, instead of being rediscovered in each page.
 *
 * Rs. 10 million (the column's ceiling) is far inside the 2^53 range where a
 * JS number is exact to the paisa, so the outbound conversion loses nothing.
 */

/** A Decimal (or null) on its way out to a client. */
export const toNumber = <T extends Prisma.Decimal | null | undefined>(
  value: T,
): T extends null | undefined ? number | null : number =>
  (value == null ? null : value.toNumber()) as never;

/**
 * Adds up money the exact way — decimal arithmetic all the way through, and a
 * number only at the very end.
 *
 * `[].reduce` on Decimals would need a seed anyway, so the empty case is
 * handled here rather than at each call site.
 */
export const sum = (values: readonly (Prisma.Decimal | null | undefined)[]): number =>
  values
    .reduce<Prisma.Decimal>(
      (total, v) => (v == null ? total : total.plus(v)),
      new Prisma.Decimal(0),
    )
    .toNumber();

/**
 * Serialises a row that carries money fields, replacing each named field with
 * its numeric form and leaving everything else untouched.
 *
 * Typed so the result still says `number` for those keys, which is what stops
 * a forgotten field slipping out as a string.
 */
export const withMoney = <T extends object, K extends keyof T>(
  row: T,
  ...fields: readonly K[]
): Omit<T, K> & { [P in K]: T[P] extends Prisma.Decimal | null ? number | null : number } => {
  const out = { ...row } as Record<string, unknown>;
  for (const f of fields) {
    const v = row[f] as Prisma.Decimal | null | undefined;
    out[f as string] = v == null ? null : v.toNumber();
  }
  return out as never;
};
