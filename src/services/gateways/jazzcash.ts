import type { InitiateInput, InitiateResult, PaymentGateway, VerifyResult } from './types.js';
import { hmacSha256Hex, safeEqual, sortedConcat } from './crypto.js';

/**
 * JazzCash Hosted Checkout.
 *
 * Fields are the provider's `pp_`-prefixed set, signed with HMAC-SHA256 over
 * every non-empty `pp_` field sorted by key, prefixed with the integrity salt.
 *
 * Two details here are the difference between working and quietly wrong:
 *
 *   - Amounts go over the wire in *paisa*, not rupees. Sending 2500 where the
 *     provider expects 250000 charges a hundredth of the price, and the
 *     callback would still verify.
 *   - Timestamps are `yyyyMMddHHmmss` in Pakistan Standard Time, which is
 *     UTC+5 with no daylight saving. A server running in UTC that formats
 *     local time sends a transaction dated five hours in the past, and
 *     JazzCash rejects it as expired.
 */

const PAISA_PER_RUPEE = 100;
/** PKT is UTC+5 year-round. */
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

/** `yyyyMMddHHmmss` in Pakistan Standard Time. */
const pktStamp = (at: Date): string => {
  const d = new Date(at.getTime() + PKT_OFFSET_MS);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
};

/**
 * JazzCash's transaction reference: alphanumeric, and short enough for their
 * field limit, so our UUID intent id cannot be used directly. The dashes are
 * stripped and the first 20 hex characters kept — collision odds across a
 * single gym's checkouts are negligible, and the intent id itself still
 * travels in `ppmpf_1` where we read it back.
 */
const txnRef = (intentId: string, at: Date): string =>
  `T${pktStamp(at)}${intentId.replace(/-/g, '').slice(0, 8)}`.slice(0, 20);

/**
 * Built against a credential prefix rather than fixed variable names.
 *
 * Two different accounts speak JazzCash here: the gym's own, which its members
 * pay into, and the platform's, which gyms pay their subscription into. The
 * protocol is identical and the secrets are not, so the difference is carried
 * as a prefix instead of a second copy of this file — a copy would be two
 * places to get the paisa conversion or the PKT timestamp wrong.
 */
export const makeJazzcash = (prefix = ''): PaymentGateway => {
  const env = (key: string): string => process.env[`${prefix}${key}`] ?? '';

  return {
  provider: 'jazzcash',
  label: 'JazzCash',

  isConfigured: () =>
    Boolean(
      env('JAZZCASH_MERCHANT_ID') &&
        env('JAZZCASH_PASSWORD') &&
        env('JAZZCASH_INTEGRITY_SALT'),
    ),

  initiate: (input: InitiateInput): InitiateResult => {
    const now = new Date();
    const ref = txnRef(input.intentId, now);
    const expiry = new Date(now.getTime() + 60 * 60 * 1000);

    const fields: Record<string, string> = {
      pp_Version: '1.1',
      pp_TxnType: 'MWALLET',
      pp_Language: 'EN',
      pp_MerchantID: env('JAZZCASH_MERCHANT_ID'),
      pp_Password: env('JAZZCASH_PASSWORD'),
      pp_TxnRefNo: ref,
      // Paisa, not rupees — see the note above. Rounded because the column
      // allows two decimal places and the provider accepts only integers.
      pp_Amount: String(Math.round(input.amount * PAISA_PER_RUPEE)),
      pp_TxnCurrency: 'PKR',
      pp_TxnDateTime: pktStamp(now),
      pp_TxnExpiryDateTime: pktStamp(expiry),
      pp_BillReference: input.intentId.slice(0, 20),
      pp_Description: input.description.slice(0, 100),
      pp_ReturnURL: input.returnUrl,
      // Round-trips our own id so the callback can be matched even if the
      // provider truncates or reformats its own reference.
      ppmpf_1: input.intentId,
    };

    fields.pp_SecureHash = hmacSha256Hex(
      env('JAZZCASH_INTEGRITY_SALT'),
      `${env('JAZZCASH_INTEGRITY_SALT')}&${sortedConcat(fields)}`,
    );

    return {
      url:
        env('JAZZCASH_POST_URL') ||
        'https://sandbox.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform',
      fields,
      providerRef: ref,
    };
  },

  verifyCallback: (body: Record<string, unknown>): VerifyResult => {
    const salt = env('JAZZCASH_INTEGRITY_SALT');
    // A gateway with no secret cannot tell a real callback from a forged one,
    // so it must refuse rather than fall back to trusting the body.
    if (!salt) return { ok: false, reason: 'jazzcash not configured' };

    const received = String(body.pp_SecureHash ?? '');
    if (!received) return { ok: false, reason: 'missing pp_SecureHash' };

    // Only `pp_` fields take part; the provider adds routing keys of its own
    // that were never signed, and including them would never match.
    const signed = Object.fromEntries(
      Object.entries(body).filter(([k]) => k.startsWith('pp_') || k.startsWith('ppmpf_')),
    );
    const expected = hmacSha256Hex(salt, `${salt}&${sortedConcat(signed, ['pp_SecureHash'])}`);
    if (!safeEqual(expected, received)) return { ok: false, reason: 'signature mismatch' };

    const ref = String(body.pp_TxnRefNo ?? '');
    if (!ref) return { ok: false, reason: 'missing pp_TxnRefNo' };

    const paisa = Number(body.pp_Amount);
    if (!Number.isFinite(paisa)) return { ok: false, reason: 'missing pp_Amount' };

    // '000' is success; '121' is the sandbox's success code. Everything else,
    // including an absent code, is a declined payment rather than a forgery.
    const code = String(body.pp_ResponseCode ?? '');
    const paid = code === '000' || code === '121';

    return {
      ok: true,
      providerRef: ref,
      amount: paisa / PAISA_PER_RUPEE,
      paid,
      failureReason: paid
        ? undefined
        : `${code || 'unknown'}: ${String(body.pp_ResponseMessage ?? 'declined')}`,
    };
  },
  };
};

/** The gym's own JazzCash account — what its members pay into. */
export const jazzcash: PaymentGateway = makeJazzcash();
