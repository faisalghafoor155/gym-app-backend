import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BiometricCryptoError,
  biometricKeyStatus,
  decryptTemplate,
  encryptTemplate,
  resetKeyRingForTests,
} from '../../src/services/fingerprint/crypto.js';

/**
 * Encryption for stored fingerprint templates.
 *
 * The properties worth pinning down are the ones whose absence would be silent:
 * that the database never sees plaintext, that a row cannot be moved between
 * members, and that an unreadable row fails loudly instead of passing for a
 * finger that did not match.
 */

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');

const original = process.env.BIOMETRIC_KEY;

/** Points the module at a key ring, discarding the one it cached. */
const useKeys = (value: string | undefined): void => {
  if (value === undefined) delete process.env.BIOMETRIC_KEY;
  else process.env.BIOMETRIC_KEY = value;
  resetKeyRingForTests();
};

beforeEach(() => useKeys(KEY_A));

afterEach(() => useKeys(original));

describe('encrypting a template', () => {
  it('round-trips the exact bytes', () => {
    const plain = Buffer.from('zkteco-template-bytes');

    const sealed = encryptTemplate(plain, 'member-1');

    expect(decryptTemplate(Buffer.from(sealed), 'member-1')).toEqual(plain);
  });

  it('round-trips an empty template', () => {
    // A device that returns zero bytes is a device bug, but it must not become
    // a crash in the crypto layer on the way to being one.
    const sealed = encryptTemplate(Buffer.alloc(0), 'member-1');

    expect(decryptTemplate(Buffer.from(sealed), 'member-1')).toEqual(Buffer.alloc(0));
  });

  it('never leaves the plaintext in what gets stored', () => {
    // The whole point: what reaches the Bytes column must not contain the
    // template. A cipher that silently fell back to storing plaintext would
    // pass the round-trip test above and fail this one.
    const plain = Buffer.from('recognisable-finger-data');

    const sealed = Buffer.from(encryptTemplate(plain, 'member-1'));

    expect(sealed.includes(plain)).toBe(false);
  });

  it('produces different ciphertext each time for the same finger', () => {
    // A fresh IV per write. Without one, two members enrolling the same finger
    // would produce identical rows, and the database would leak that fact to
    // anyone who could read it.
    const plain = Buffer.from('same-finger');

    const first = Buffer.from(encryptTemplate(plain, 'member-1'));
    const second = Buffer.from(encryptTemplate(plain, 'member-1'));

    expect(first.equals(second)).toBe(false);
    expect(decryptTemplate(first, 'member-1')).toEqual(plain);
    expect(decryptTemplate(second, 'member-1')).toEqual(plain);
  });
});

describe('binding a template to its member', () => {
  it('refuses to decrypt under a different member id', () => {
    // The row-moved-between-members case. Decrypting cleanly here would mean a
    // template copied into somebody else's row opens the door for them.
    const sealed = Buffer.from(encryptTemplate(Buffer.from('alice'), 'member-1'));

    expect(() => decryptTemplate(sealed, 'member-2')).toThrow(BiometricCryptoError);
  });
});

describe('reading a damaged row', () => {
  it('rejects a modified ciphertext rather than returning garbage', () => {
    const sealed = Buffer.from(encryptTemplate(Buffer.from('finger'), 'member-1'));
    sealed[sealed.length - 1] ^= 0xff;

    expect(() => decryptTemplate(sealed, 'member-1')).toThrow(BiometricCryptoError);
  });

  it('rejects a row too short to hold an envelope', () => {
    expect(() => decryptTemplate(Buffer.from([1, 1, 2, 3]), 'member-1')).toThrow(
      BiometricCryptoError,
    );
  });

  it('rejects an envelope version it does not know', () => {
    // What a rollback to an older build would hit. Better a clear refusal than
    // an attempt to read the layout at offsets that mean something else now.
    const sealed = Buffer.from(encryptTemplate(Buffer.from('finger'), 'member-1'));
    sealed[0] = 99;

    expect(() => decryptTemplate(sealed, 'member-1')).toThrow(/version 99/);
  });

  it('says so plainly when the key that wrote a row is gone', () => {
    const sealed = Buffer.from(encryptTemplate(Buffer.from('finger'), 'member-1'));

    // A rotation that dropped the old key before re-encrypting the rows.
    useKeys(`2:${KEY_B}`);

    expect(() => decryptTemplate(sealed, 'member-1')).toThrow(/key id 1/);
  });

  it('does not repeat the template in the error', () => {
    const plain = Buffer.from('recognisable-finger-data');
    const sealed = Buffer.from(encryptTemplate(plain, 'member-1'));
    sealed[sealed.length - 1] ^= 0xff;

    // An error message is the one thing certain to be logged, so it is the last
    // place biometric bytes should end up.
    expect(() => decryptTemplate(sealed, 'member-2')).toThrow(
      expect.not.stringContaining('recognisable') as unknown as string,
    );
  });
});

describe('rotating the key', () => {
  it('writes under the new key while old rows still open', () => {
    const old = Buffer.from(encryptTemplate(Buffer.from('enrolled-earlier'), 'member-1'));

    // New key first, old one kept: the state a gym is in mid-rotation.
    useKeys(`2:${KEY_B},1:${KEY_A}`);

    expect(decryptTemplate(old, 'member-1')).toEqual(Buffer.from('enrolled-earlier'));

    const fresh = Buffer.from(encryptTemplate(Buffer.from('enrolled-now'), 'member-2'));
    expect(fresh[1]).toBe(2);
    expect(decryptTemplate(fresh, 'member-2')).toEqual(Buffer.from('enrolled-now'));
  });

  it('treats a bare key as id 1, so a gym that never rotates keeps working', () => {
    const sealed = Buffer.from(encryptTemplate(Buffer.from('finger'), 'member-1'));

    expect(sealed[1]).toBe(1);

    // The same key written the long way must open it.
    useKeys(`1:${KEY_A}`);
    expect(decryptTemplate(sealed, 'member-1')).toEqual(Buffer.from('finger'));
  });
});

describe('checking the key at boot', () => {
  it('accepts a well-formed key', () => {
    expect(biometricKeyStatus()).toEqual({ ok: true });
  });

  it('reports a missing key rather than throwing', () => {
    useKeys(undefined);

    const status = biometricKeyStatus();
    expect(status.ok).toBe(false);
    expect(status.ok === false && status.error).toMatch(/BIOMETRIC_KEY is not set/);
  });

  it('rejects a key of the wrong length', () => {
    // The likeliest typo: a 16-byte key, or one truncated on the way into a
    // secret manager. Caught at boot, not at the first enrolment.
    useKeys(Buffer.alloc(16, 1).toString('base64'));

    const status = biometricKeyStatus();
    expect(status.ok).toBe(false);
    expect(status.ok === false && status.error).toMatch(/must be exactly 32/);
  });

  it('rejects a key ring that lists an id twice', () => {
    useKeys(`1:${KEY_A},1:${KEY_B}`);

    const status = biometricKeyStatus();
    expect(status.ok).toBe(false);
    expect(status.ok === false && status.error).toMatch(/twice/);
  });

  it('rejects an unusable key id', () => {
    useKeys(`0:${KEY_A}`);

    const status = biometricKeyStatus();
    expect(status.ok).toBe(false);
    expect(status.ok === false && status.error).toMatch(/1 to 255/);
  });
});
