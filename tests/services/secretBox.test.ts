/** @format */

import { describe, expect, it } from 'vitest';
import {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  SecretBoxError,
} from '../../src/services/secretBox.js';

/**
 * Encrypting the short secrets that live in text columns — today, the TOTP
 * seed behind every 2FA login.
 *
 * Two properties carry the weight. The value must not be recoverable from the
 * stored string, which is the whole point; and a value bound to one user must
 * not decrypt under another, or somebody with write access could move their
 * own seed onto an account they wanted into and pass its second factor with
 * their own authenticator app.
 *
 * The third is unglamorous and matters just as much: plaintext written before
 * this existed has to keep working, because those rows are in every deployed
 * database and breaking them would lock people out of their own accounts.
 */

const CONTEXT = 'user-1';
const SECRET = 'JBSWY3DPEHPK3PXP';

describe('encryptSecret', () => {
  it('does not leave the secret readable in what it stores', () => {
    const stored = encryptSecret(SECRET, CONTEXT);

    expect(stored).not.toContain(SECRET);
    expect(isEncrypted(stored)).toBe(true);
  });

  it('round-trips', () => {
    expect(decryptSecret(encryptSecret(SECRET, CONTEXT), CONTEXT)).toBe(SECRET);
  });

  it('produces a different string every time', () => {
    // A fresh IV per write. Without one, two users with the same seed would
    // store identical strings and a dump would show they matched.
    const a = encryptSecret(SECRET, CONTEXT);
    const b = encryptSecret(SECRET, CONTEXT);

    expect(a).not.toBe(b);
    expect(decryptSecret(a, CONTEXT)).toBe(decryptSecret(b, CONTEXT));
  });

  it('handles a secret with characters outside ASCII', () => {
    const emoji = 'passphrase-با-پاکستان-🇵🇰';
    expect(decryptSecret(encryptSecret(emoji, CONTEXT), CONTEXT)).toBe(emoji);
  });

  it('handles an empty secret', () => {
    expect(decryptSecret(encryptSecret('', CONTEXT), CONTEXT)).toBe('');
  });
});

describe('decryptSecret', () => {
  it('refuses a secret bound to somebody else', () => {
    const stored = encryptSecret(SECRET, 'user-1');

    expect(() => decryptSecret(stored, 'user-2')).toThrow(SecretBoxError);
  });

  it('refuses a row that has been altered', () => {
    const stored = encryptSecret(SECRET, CONTEXT);
    // Flip a character in the ciphertext segment.
    const parts = stored.split('.');
    const body = parts[4]!;
    parts[4] = (body[0] === 'A' ? 'B' : 'A') + body.slice(1);

    expect(() => decryptSecret(parts.join('.'), CONTEXT)).toThrow(SecretBoxError);
  });

  it('refuses a truncated envelope', () => {
    expect(() => decryptSecret('v1.1.abc', CONTEXT)).toThrow(SecretBoxError);
  });

  it('names the key when it was written under one that is not loaded', () => {
    const stored = encryptSecret(SECRET, CONTEXT);
    const parts = stored.split('.');
    parts[1] = '99';

    // The message has to say what to do — an operator mid-rotation needs to
    // know the old key is missing, not just that something failed.
    expect(() => decryptSecret(parts.join('.'), CONTEXT)).toThrow(/key id 99/);
  });

  it('never puts the secret into the error it throws', () => {
    const stored = encryptSecret(SECRET, 'user-1');
    try {
      decryptSecret(stored, 'user-2');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(String(err)).not.toContain(SECRET);
    }
  });
});

describe('secrets written before encryption existed', () => {
  it('reads plaintext straight through', () => {
    // Every row already in a deployed database looks like this.
    expect(decryptSecret(SECRET, CONTEXT)).toBe(SECRET);
  });

  it('does not mistake plaintext for something encrypted', () => {
    expect(isEncrypted(SECRET)).toBe(false);
    expect(isEncrypted('')).toBe(false);
  });

  it('reads plaintext under any context', () => {
    // A plaintext row is not bound to anyone, so it cannot be checked against
    // a context — and pretending otherwise would break exactly the accounts
    // this compatibility path exists for.
    expect(decryptSecret(SECRET, 'anybody')).toBe(SECRET);
  });

  it('still refuses something that claims to be encrypted and is not', () => {
    // The prefix is the promise. A tampered row must not fall back to being
    // read as plaintext and handed to a verifier.
    expect(() => decryptSecret('v1.1.a.b.c', CONTEXT)).toThrow(SecretBoxError);
  });
});
