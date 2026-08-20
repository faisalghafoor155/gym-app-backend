import { describe, expect, it } from 'vitest';

import {
  normalizeName,
  normalizePhone,
} from '../../src/services/memberDuplicate.js';

/**
 * The two normalisers decide what "the same person" means, so they are where
 * the rules are actually worth pinning down. `findDuplicateMember` itself hits
 * the database and is covered by the integration suite.
 */

describe('normalizePhone', () => {
  it('reads one number written three ways as one number', () => {
    const forms = ['03001234567', '+92 300 1234567', '(0300) 123-4567', '923001234567'];
    const normalized = forms.map(normalizePhone);
    expect(new Set(normalized).size).toBe(1);
    expect(normalized[0]).toBe('3001234567');
  });

  it('keeps genuinely different numbers apart', () => {
    expect(normalizePhone('03001234567')).not.toBe(normalizePhone('03001234568'));
  });

  it('treats an absent phone as no value rather than an empty one', () => {
    // Two members with no phone must not be found to share it.
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone('   ')).toBeNull();
    expect(normalizePhone('-- ()')).toBeNull();
  });

  it('does not strip a number down to nothing', () => {
    // All zeroes is not a real number, but returning "" would make it match
    // every other unparseable one.
    expect(normalizePhone('0000')).toBe('0000');
  });
});

describe('normalizeName', () => {
  it('ignores case and spacing', () => {
    expect(normalizeName('  Ahmed   Khan ')).toBe(normalizeName('ahmed khan'));
  });

  it('keeps different names apart', () => {
    expect(normalizeName('Ahmed Khan')).not.toBe(normalizeName('Ahmad Khan'));
  });

  it('treats an absent name as no value', () => {
    expect(normalizeName('')).toBeNull();
    expect(normalizeName('   ')).toBeNull();
    expect(normalizeName(null)).toBeNull();
  });
});
