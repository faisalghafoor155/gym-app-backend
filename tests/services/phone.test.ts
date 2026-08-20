/** @format */

import { describe, expect, it } from 'vitest';
import { toWhatsAppNumber, canWhatsApp } from '../../src/services/phone.js';

/**
 * Turning stored phone numbers into WhatsApp addresses.
 *
 * The two failures here are not equal. A number that refuses to convert sends
 * nothing, which shows up in the run counts and can be chased. A number that
 * converts *wrongly* sends one member's renewal notice to whoever owns the
 * number it landed on — silent, and the first anyone hears of it is a stranger
 * asking why a gym is messaging them.
 *
 * So these lean on the second: anything ambiguous must come back null rather
 * than be guessed into a plausible-looking number.
 */

describe('toWhatsAppNumber — what the front desk actually types', () => {
  it('converts the local form the app stores', () => {
    // `03001234567` is what every member record in the database looks like.
    expect(toWhatsAppNumber('03001234567')).toBe('923001234567');
  });

  it('accepts the separators people write by hand', () => {
    // All four are the same number as far as a person reading it aloud is
    // concerned, and all four turn up in a roster somebody typed.
    expect(toWhatsAppNumber('0300-1234567')).toBe('923001234567');
    expect(toWhatsAppNumber('0300 1234567')).toBe('923001234567');
    expect(toWhatsAppNumber('(0300) 123-4567')).toBe('923001234567');
    expect(toWhatsAppNumber('+92 300 1234567')).toBe('923001234567');
  });

  it('leaves an already-international number alone', () => {
    expect(toWhatsAppNumber('923001234567')).toBe('923001234567');
    expect(toWhatsAppNumber('+923001234567')).toBe('923001234567');
  });

  it('takes the national form written without its trunk zero', () => {
    expect(toWhatsAppNumber('3001234567')).toBe('923001234567');
  });

  it('covers every operator prefix in use', () => {
    // 030–036 are the allocated mobile ranges. A member on a newer network
    // must not be silently unreachable because the check was written against
    // whichever operator the author happened to use.
    for (const prefix of ['030', '031', '032', '033', '034', '035', '036']) {
      expect(toWhatsAppNumber(`${prefix}01234567`)).toBe(`92${prefix.slice(1)}01234567`);
    }
  });
});

describe('toWhatsAppNumber — what it refuses', () => {
  it('refuses a landline', () => {
    // A real, dialable number that cannot receive WhatsApp. Gyms record these
    // as emergency contacts, so this is not a hypothetical.
    expect(toWhatsAppNumber('042-35881234')).toBeNull();
    expect(toWhatsAppNumber('0213456789')).toBeNull();
  });

  it('refuses a number of the wrong length', () => {
    // One digit short and one digit long. Both are typos that would otherwise
    // convert into a number belonging to somebody else entirely.
    expect(toWhatsAppNumber('030012345')).toBeNull();
    expect(toWhatsAppNumber('030012345678')).toBeNull();
  });

  it('refuses an empty or missing field', () => {
    expect(toWhatsAppNumber('')).toBeNull();
    expect(toWhatsAppNumber(null)).toBeNull();
    expect(toWhatsAppNumber(undefined)).toBeNull();
    // A phone column holding a note rather than a number.
    expect(toWhatsAppNumber('n/a')).toBeNull();
    expect(toWhatsAppNumber('-')).toBeNull();
  });

  it('refuses a country code with a body that is not a mobile', () => {
    // `92` followed by a landline. The country code alone is not enough to
    // make something reachable.
    expect(toWhatsAppNumber('924235881234')).toBeNull();
  });
});

describe('toWhatsAppNumber — members from abroad', () => {
  it('passes through a foreign number written in international form', () => {
    // An expatriate member's UAE number. This cannot verify the mobile ranges
    // of every country, so it checks the shape and lets Meta reject what is
    // genuinely wrong — refusing outright would make them unreachable.
    expect(toWhatsAppNumber('+971501234567')).toBe('971501234567');
    expect(toWhatsAppNumber('00971501234567')).toBe('971501234567');
  });

  it('still refuses a foreign number too short to be real', () => {
    expect(toWhatsAppNumber('00123')).toBeNull();
  });
});

describe('canWhatsApp', () => {
  it('agrees with the conversion it stands in for', () => {
    // One decision, asked two ways. A gym filtering "who can we message" and
    // the send itself must never disagree about a given member.
    expect(canWhatsApp('03001234567')).toBe(true);
    expect(canWhatsApp('042-35881234')).toBe(false);
    expect(canWhatsApp(null)).toBe(false);
  });
});
