import crypto from 'node:crypto';

/**
 * Signature comparison that does not leak the answer through timing.
 *
 * `===` on strings returns as soon as two bytes differ, so how long a rejection
 * takes tells an attacker how much of their guess was right — enough, over many
 * attempts, to reconstruct a valid signature one character at a time.
 * `timingSafeEqual` always reads both buffers to the end.
 *
 * It throws on a length mismatch, which would itself be a timing signal, so
 * lengths are compared first and a mismatch is reported as a plain non-match.
 */
export const safeEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};

/**
 * The string both Pakistani gateways sign: their own fields, sorted by key,
 * joined with `&`, with the shared secret in front.
 *
 * Only non-empty values take part — both providers drop empty fields before
 * hashing, and including them here would produce a hash that never matches.
 * The signature field itself is excluded by the caller, since it cannot be an
 * input to its own computation.
 */
export const sortedConcat = (
  fields: Record<string, unknown>,
  exclude: readonly string[] = [],
): string => {
  const skip = new Set(exclude);
  return Object.keys(fields)
    .filter((k) => !skip.has(k))
    .sort()
    .map((k) => (fields[k] == null ? '' : String(fields[k])))
    .filter((v) => v !== '')
    .join('&');
};

/** HMAC-SHA256, uppercase hex — JazzCash's `pp_SecureHash`. */
export const hmacSha256Hex = (secret: string, payload: string): string =>
  crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex').toUpperCase();

/** Plain SHA-256, uppercase hex. */
export const sha256Hex = (payload: string): string =>
  crypto.createHash('sha256').update(payload, 'utf8').digest('hex').toUpperCase();
