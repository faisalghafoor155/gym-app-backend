import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';

import { sum, toNumber, withMoney } from '../../src/services/money.js';

const d = (v: string | number) => new Prisma.Decimal(v);

describe('toNumber', () => {
  it('converts a Decimal to a plain number', () => {
    expect(toNumber(d('2500.00'))).toBe(2500);
    expect(toNumber(d('1234.56'))).toBe(1234.56);
  });

  it('passes null and undefined through as null', () => {
    expect(toNumber(null)).toBeNull();
    expect(toNumber(undefined)).toBeNull();
  });

  it('produces a number, not the string JSON.stringify would emit', () => {
    // The whole reason this helper exists: an untouched Decimal serialises as
    // "2500", which would break every .toLocaleString() in the UI.
    expect(JSON.stringify({ fee: toNumber(d('2500.00')) })).toBe('{"fee":2500}');
    expect(JSON.stringify({ fee: d('2500.00') })).toBe('{"fee":"2500"}');
  });

  it('is exact at the top of the Decimal(10,2) range', () => {
    expect(toNumber(d('99999999.99'))).toBe(99999999.99);
  });
});

describe('sum', () => {
  it('returns 0 for an empty list', () => {
    expect(sum([])).toBe(0);
  });

  it('adds Decimals exactly where floats would drift', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in binary floating point.
    expect(sum([d('0.10'), d('0.20')])).toBe(0.3);
  });

  it('keeps a long run of payments exact to the paisa', () => {
    // Ten 0.10 payments: float addition lands on 0.9999999999999999.
    expect(sum(Array.from({ length: 10 }, () => d('0.10')))).toBe(1);
  });

  it('skips null and undefined entries rather than counting them as zero-ish', () => {
    expect(sum([d('100.00'), null, d('50.50'), undefined])).toBe(150.5);
  });

  it('handles negatives, as a refund would produce', () => {
    expect(sum([d('500.00'), d('-200.00')])).toBe(300);
  });

  it('does not mutate its inputs', () => {
    const a = d('100.00');
    sum([a, d('50.00')]);
    expect(a.toString()).toBe('100');
  });
});

describe('withMoney', () => {
  it('replaces the named fields with numbers', () => {
    const row = { id: 'p1', amount: d('2500.00'), note: 'monthly' };
    expect(withMoney(row, 'amount')).toEqual({ id: 'p1', amount: 2500, note: 'monthly' });
  });

  it('converts several fields at once', () => {
    const row = { id: 's1', price: d('1200.00'), cost: d('800.00') };
    expect(withMoney(row, 'price', 'cost')).toEqual({ id: 's1', price: 1200, cost: 800 });
  });

  it('leaves a null money field null instead of turning it into 0', () => {
    // An unpriced row and a free one are different facts.
    const row = { id: 'p1', amount: null };
    expect(withMoney(row, 'amount').amount).toBeNull();
  });

  it('leaves non-money fields untouched, including Dates', () => {
    const paidAt = new Date('2026-01-15T10:00:00Z');
    const row = { id: 'p1', amount: d('100.00'), paidAt, type: 'membership' };
    const out = withMoney(row, 'amount');
    expect(out.paidAt).toBe(paidAt);
    expect(out.type).toBe('membership');
  });

  it('copies rather than mutating the row it was given', () => {
    const row = { id: 'p1', amount: d('2500.00') };
    const out = withMoney(row, 'amount');
    expect(out).not.toBe(row);
    expect(Prisma.Decimal.isDecimal(row.amount)).toBe(true);
  });

  it('serialises a converted row as numbers end to end', () => {
    const row = { id: 'p1', amount: d('2500.00'), outstanding: d('0.00') };
    expect(JSON.stringify(withMoney(row, 'amount', 'outstanding')))
      .toBe('{"id":"p1","amount":2500,"outstanding":0}');
  });
});
