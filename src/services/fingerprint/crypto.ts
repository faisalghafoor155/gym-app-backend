import crypto from "node:crypto";

/**
 * Encryption for the one piece of biometric data this application keeps.
 *
 * Everything else in the database is replaceable. A member whose phone number
 * leaks changes their number; a member whose fingerprint template leaks cannot
 * change their finger. Disk encryption alone does not cover the ways this data
 * actually escapes — a `pg_dump` copied to a laptop, a read replica, a backup
 * bucket, a stolen `DATABASE_URL` — because in all of those the database hands
 * the bytes over willingly. Encrypting above the database means the ciphertext
 * is what leaks, and the key is somewhere the database never sees.
 *
 * AES-256-GCM: authenticated, so a modified row is rejected rather than fed to
 * a matcher as a corrupt template.
 *
 * ## The stored layout
 *
 *   version (1) | keyId (1) | iv (12) | authTag (16) | ciphertext (n)
 *
 * Packed into the existing `Bytes` column rather than spread across new ones.
 * A template is opaque to everything above the device adapter — nothing sorts,
 * filters or indexes it — so it costs nothing to keep the envelope in the same
 * cell, and it means encryption arrived without a schema change to reason about
 * during a migration.
 *
 * `version` is what makes a future change to the scheme survivable: a reader of
 * this data checks it before assuming anything about the rest of the layout.
 * `keyId` is the same idea for the key itself — see `BIOMETRIC_KEY` below.
 */

/** Envelope format. Bump only if the layout below changes. */
const VERSION = 1;

/** AES-256-GCM's standard nonce length. Not a knob: 12 is what GCM is defined for. */
const IV_BYTES = 12;
/** GCM's authentication tag. */
const TAG_BYTES = 16;
/** AES-256 needs exactly this many key bytes. */
const KEY_BYTES = 32;

const VERSION_OFFSET = 0;
const KEY_ID_OFFSET = 1;
const IV_OFFSET = 2;
const TAG_OFFSET = IV_OFFSET + IV_BYTES;
const CIPHERTEXT_OFFSET = TAG_OFFSET + TAG_BYTES;

/** Thrown when a template cannot be read back. Never carries the bytes. */
export class BiometricCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BiometricCryptoError";
  }
}

/**
 * The keys this process can decrypt with, by id.
 *
 * More than one because rotation has to be possible without a flag day. The
 * primary key encrypts; every listed key can decrypt, so rows written under an
 * older key keep opening while they are re-encrypted. A gym that never rotates
 * sets one variable and never thinks about this again.
 *
 * Read once at module load. A key that changes under a running process would
 * mean rows written minutes apart needing different keys with nothing recording
 * which — the failure would surface as unreadable enrolments long after the
 * change that caused it.
 */
interface KeyRing {
  /** Key id used for new writes. */
  primaryId: number;
  /** Every key this process can decrypt with, by id. */
  keys: Map<number, Buffer>;
}

/**
 * Parses one `id:base64` entry, or a bare key as id 1.
 *
 * The bare form is what a gym setting this up for the first time writes, and it
 * stays valid forever — ids only become visible when somebody rotates.
 */
const parseKey = (entry: string): { id: number; key: Buffer } => {
  const trimmed = entry.trim();
  const separator = trimmed.indexOf(":");
  const [rawId, rawKey] =
    separator === -1
      ? ["1", trimmed]
      : [trimmed.slice(0, separator), trimmed.slice(separator + 1)];

  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 1 || id > 255) {
    throw new BiometricCryptoError(
      `BIOMETRIC_KEY has key id "${rawId}"; ids must be whole numbers from 1 to 255`,
    );
  }

  // `base64` decoding does not fail on junk, it discards it — so a mistyped key
  // would otherwise become a short buffer and surface as a confusing error from
  // `createCipheriv`. The length check below is what actually catches it, and
  // it is worth being explicit about the count in the message.
  const key = Buffer.from(rawKey.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new BiometricCryptoError(
      `BIOMETRIC_KEY id ${id} decodes to ${key.length} bytes; it must be exactly ` +
        `${KEY_BYTES}. Generate one with: openssl rand -base64 32`,
    );
  }

  return { id, key };
};

/**
 * Reads `BIOMETRIC_KEY` into a key ring.
 *
 * One key:            `BIOMETRIC_KEY="<base64>"`
 * Rotating:           `BIOMETRIC_KEY="2:<new base64>,1:<old base64>"`
 *
 * The first entry is the primary. Order rather than a separate variable,
 * because the two cannot then disagree.
 */
const readKeyRing = (): KeyRing => {
  const raw = process.env.BIOMETRIC_KEY;
  if (!raw || !raw.trim()) {
    throw new BiometricCryptoError(
      "BIOMETRIC_KEY is not set. Fingerprint templates cannot be stored or read " +
        "without it. Generate one with: openssl rand -base64 32",
    );
  }

  const entries = raw.split(",").filter((e) => e.trim());
  const keys = new Map<number, Buffer>();
  let primaryId: number | null = null;

  for (const entry of entries) {
    const { id, key } = parseKey(entry);
    if (keys.has(id)) {
      throw new BiometricCryptoError(
        `BIOMETRIC_KEY lists key id ${id} twice; ids must be unique`,
      );
    }
    keys.set(id, key);
    primaryId ??= id;
  }

  if (primaryId === null) {
    throw new BiometricCryptoError("BIOMETRIC_KEY is empty");
  }

  return { primaryId, keys };
};

let cached: KeyRing | null = null;

const keyRing = (): KeyRing => (cached ??= readKeyRing());

/**
 * Whether a usable key is configured, without throwing.
 *
 * For the boot check, which wants to report the problem and exit rather than
 * fail on the first enrolment months later.
 */
export const biometricKeyStatus = (): { ok: true } | { ok: false; error: string } => {
  try {
    keyRing();
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "BIOMETRIC_KEY is not usable",
    };
  }
};

/** Discards the parsed key ring. Tests only — see `readKeyRing`'s note. */
export const resetKeyRingForTests = (): void => {
  cached = null;
};

/**
 * Binds the ciphertext to the member it was enrolled against.
 *
 * GCM's additional authenticated data is covered by the tag but not stored, so
 * decrypting a row under a different member id fails outright. Without it, a
 * row copied from one member to another — by a bad UPDATE, or by somebody with
 * write access and a motive — would decrypt cleanly and let the wrong person
 * through the door. The member id is already the row's unique key, so there is
 * nothing extra to keep in step.
 */
const aad = (memberId: string): Buffer => Buffer.from(memberId, "utf8");

/**
 * Encrypts a template for storage against `memberId`.
 *
 * The output is what goes in `FingerprintTemplate.template`; nothing else may
 * be written to that column.
 *
 * Returns `Uint8Array<ArrayBuffer>` rather than `Buffer` because that is what
 * Prisma's `Bytes` accepts. Node's `Buffer` is typed over `ArrayBufferLike`,
 * which admits a `SharedArrayBuffer` backing that Prisma's narrower type
 * rejects, so the envelope is copied into a buffer of the exact type. Done here
 * once rather than with a cast at every call site.
 */
export const encryptTemplate = (
  plain: Buffer,
  memberId: string,
): Uint8Array<ArrayBuffer> => {
  const { primaryId, keys } = keyRing();
  const key = keys.get(primaryId)!;

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(memberId));

  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = Buffer.concat([
    Buffer.from([VERSION, primaryId]),
    iv,
    tag,
    ciphertext,
  ]);

  const out = new Uint8Array(new ArrayBuffer(envelope.length));
  out.set(envelope);
  return out;
};

/**
 * Reads a stored template back.
 *
 * Throws rather than returning null on anything unexpected. A template that
 * cannot be authenticated is not a soft failure to skip past — every path that
 * reads one is deciding whether to open a door, and "could not read this row"
 * must never be indistinguishable from "this finger did not match".
 */
export const decryptTemplate = (stored: Buffer, memberId: string): Buffer => {
  if (stored.length < CIPHERTEXT_OFFSET) {
    throw new BiometricCryptoError(
      "Stored fingerprint template is too short to be readable",
    );
  }

  const version = stored[VERSION_OFFSET];
  if (version !== VERSION) {
    throw new BiometricCryptoError(
      `Stored fingerprint template has envelope version ${version}; this build reads ${VERSION}`,
    );
  }

  const keyId = stored[KEY_ID_OFFSET]!;
  const { keys } = keyRing();
  const key = keys.get(keyId);
  if (!key) {
    // The likeliest cause by far is a rotation that dropped the old key from
    // BIOMETRIC_KEY before the rows using it were re-encrypted.
    throw new BiometricCryptoError(
      `Stored fingerprint template was encrypted with key id ${keyId}, which is ` +
        "not in BIOMETRIC_KEY",
    );
  }

  const iv = stored.subarray(IV_OFFSET, TAG_OFFSET);
  const tag = stored.subarray(TAG_OFFSET, CIPHERTEXT_OFFSET);
  const ciphertext = stored.subarray(CIPHERTEXT_OFFSET);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad(memberId));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Deliberately not forwarding the underlying message: it says nothing
    // useful beyond "unsupported state or unable to authenticate data", and
    // repeating it invites somebody to log it next to the row it came from.
    throw new BiometricCryptoError(
      "Stored fingerprint template failed authentication. It was modified, " +
        "encrypted against a different member, or written with a different key.",
    );
  }
};
