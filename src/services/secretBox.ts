/** @format */

import crypto from "node:crypto";
import {
  encryptionKeyRing,
  BiometricCryptoError,
} from "./fingerprint/crypto.js";

/**
 * Encryption for short secrets that live in ordinary text columns.
 *
 * The first of these is the TOTP secret. It was stored in plaintext, which
 * meant a database dump handed over every user's second factor — the attacker
 * who has the dump can generate valid codes forever, and the users cannot tell
 * because nothing about their authenticator app has changed. The fingerprint
 * templates two directories away were already encrypted for exactly this
 * reason; the seed that guards every staff account was not.
 *
 * ## Why the same key as the fingerprints
 *
 * `BIOMETRIC_KEY` is already required at boot, already validated, and already
 * has rotation built in. A second key variable would double what an operator
 * has to keep safe and give a rotation two places to be half-applied, for no
 * gain — both secrets leak through the same hole (a dump, a replica, a stolen
 * connection string) and are protected by the same property: the key is
 * somewhere the database never sees.
 *
 * ## The stored layout
 *
 *   v1.<keyId>.<iv>.<tag>.<ciphertext>      — all but the prefix base64url
 *
 * Text rather than the packed binary the templates use, because this goes in a
 * `String?` column that already exists. The dots make it parseable without
 * knowing any lengths, and the `v1` prefix is what makes a future change to the
 * scheme survivable — a reader checks it before assuming anything else.
 *
 * ## Reading a value that was never encrypted
 *
 * `decryptSecret` returns plaintext unchanged when it does not carry the
 * prefix. Secrets written before this existed are still readable, so nobody is
 * locked out of their own account by a deploy, and they are re-encrypted the
 * next time they are written. There is no migration to run and no window where
 * 2FA is broken.
 */

const PREFIX = "v1";
const IV_BYTES = 12;

/** Thrown when a stored secret cannot be read back. Never carries the value. */
export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

/**
 * Binds the ciphertext to what it belongs to.
 *
 * GCM's additional authenticated data is covered by the tag but not stored, so
 * a secret copied from one user's row to another fails to decrypt rather than
 * silently working. Without it, somebody with write access could move their own
 * TOTP secret onto an account they wanted into and pass its second factor with
 * their own authenticator app.
 */
const aad = (context: string): Buffer => Buffer.from(`secret:${context}`, "utf8");

/** Whether a stored value is one of ours, rather than a plaintext leftover. */
export const isEncrypted = (stored: string): boolean =>
  stored.startsWith(`${PREFIX}.`);

/**
 * Encrypts a secret for storage.
 *
 * `context` must be the same value on the way back out — the user's id, for a
 * TOTP secret.
 */
export const encryptSecret = (plain: string, context: string): string => {
  const { primaryId, keys } = encryptionKeyRing();
  const key = keys.get(primaryId)!;

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(context));

  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    PREFIX,
    String(primaryId),
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
};

/**
 * Reads a stored secret back.
 *
 * A value without the version prefix is returned as-is: it predates encryption
 * and is still a working secret. Anything that *claims* to be encrypted and
 * then fails to authenticate throws — a tampered row must not be mistaken for a
 * plaintext one and handed to a verifier.
 */
export const decryptSecret = (stored: string, context: string): string => {
  if (!isEncrypted(stored)) return stored;

  const parts = stored.split(".");
  if (parts.length !== 5) {
    throw new SecretBoxError("Stored secret is malformed");
  }

  const [, rawKeyId, rawIv, rawTag, rawCiphertext] = parts;
  const keyId = Number(rawKeyId);

  const { keys } = encryptionKeyRing();
  const key = keys.get(keyId);
  if (!key) {
    throw new SecretBoxError(
      `Stored secret was written with key id ${rawKeyId}, which is not in ` +
        `BIOMETRIC_KEY. Add the old key to decrypt it.`,
    );
  }

  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(rawIv!, "base64url"),
    );
    decipher.setAAD(aad(context));
    decipher.setAuthTag(Buffer.from(rawTag!, "base64url"));
    return (
      decipher.update(Buffer.from(rawCiphertext!, "base64url")).toString("utf8") +
      decipher.final("utf8")
    );
  } catch {
    // The underlying message is deliberately not forwarded. It says nothing an
    // operator can act on and would end up logged next to the row it failed on.
    throw new SecretBoxError(
      "Stored secret could not be read. It was written with a different key, " +
        "or the row has been altered.",
    );
  }
};

export { BiometricCryptoError };
