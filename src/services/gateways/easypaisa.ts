import type { InitiateInput, InitiateResult, PaymentGateway, VerifyResult } from './types.js';
import { safeEqual, sha256Hex, sortedConcat } from './crypto.js';

/**
 * Easypaisa Hosted Checkout.
 *
 * Same shape as JazzCash but three things differ, and each is a bug waiting to
 * happen if carried over by habit:
 *
 *   - Amounts are in *rupees* with two decimal places, not paisa.
 *   - The hash is a plain SHA-256 of `hashKey & sorted-fields`, not an HMAC.
 *   - Dates are `yyyy-MM-dd HH:mm:ss`, and the expiry is what stops an
 *     abandoned checkout being completed later.
 */

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

const pktDateTime = (at: Date): string => {
  const d = new Date(at.getTime() + PKT_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
};

const env = (key: string): string => process.env[key] ?? '';

export const easypaisa: PaymentGateway = {
  provider: 'easypaisa',
  label: 'Easypaisa',

  isConfigured: () => Boolean(env('EASYPAISA_STORE_ID') && env('EASYPAISA_HASH_KEY')),

  initiate: (input: InitiateInput): InitiateResult => {
    const now = new Date();
    const expiry = new Date(now.getTime() + 60 * 60 * 1000);
    // Easypaisa echoes `orderRefNum` back verbatim, so our own id can be the
    // reference directly — no truncation, nothing to reconstruct.
    const ref = input.intentId;

    const fields: Record<string, string> = {
      storeId: env('EASYPAISA_STORE_ID'),
      // Rupees with two decimals, unlike JazzCash's paisa.
      amount: input.amount.toFixed(2),
      postBackURL: input.returnUrl,
      orderRefNum: ref,
      expiryDate: pktDateTime(expiry),
      merchantHashedReq: '',
      autoRedirect: '1',
      paymentMethod: 'MA_PAYMENT_METHOD',
    };
    // Placeholder removed before hashing: an empty field would be dropped by
    // `sortedConcat` anyway, but leaving it in the object invites somebody to
    // later "fix" it into the signed set.
    delete (fields as Record<string, unknown>).merchantHashedReq;

    fields.merchantHashedReq = sha256Hex(`${env('EASYPAISA_HASH_KEY')}&${sortedConcat(fields)}`);

    return {
      url:
        env('EASYPAISA_POST_URL') ||
        'https://easypay.easypaisa.com.pk/easypay/Index.jsf',
      fields,
      providerRef: ref,
    };
  },

  verifyCallback: (body: Record<string, unknown>): VerifyResult => {
    const key = env('EASYPAISA_HASH_KEY');
    if (!key) return { ok: false, reason: 'easypaisa not configured' };

    const received = String(body.merchantHashedReq ?? body.hashRequest ?? '');
    if (!received) return { ok: false, reason: 'missing merchantHashedReq' };

    const expected = sha256Hex(
      `${key}&${sortedConcat(body, ['merchantHashedReq', 'hashRequest'])}`,
    );
    if (!safeEqual(expected, received)) return { ok: false, reason: 'signature mismatch' };

    const ref = String(body.orderRefNum ?? '');
    if (!ref) return { ok: false, reason: 'missing orderRefNum' };

    const amount = Number(body.amount);
    if (!Number.isFinite(amount)) return { ok: false, reason: 'missing amount' };

    const code = String(body.status ?? body.responseCode ?? '');
    const paid = code === '0000' || code.toUpperCase() === 'SUCCESS';

    return {
      ok: true,
      providerRef: ref,
      amount,
      paid,
      failureReason: paid
        ? undefined
        : `${code || 'unknown'}: ${String(body.desc ?? body.responseDesc ?? 'declined')}`,
    };
  },
};
