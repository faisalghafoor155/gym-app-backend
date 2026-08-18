import type { InitiateInput, InitiateResult, PaymentGateway, VerifyResult } from './types.js';

/**
 * The "no gateway configured" path, named honestly.
 *
 * A gym that has not signed up with a provider still wants the renew button to
 * do something. Here it files a request the front desk settles by hand: the
 * intent stays `pending`, staff take the cash, and a staff-only endpoint
 * confirms it. No membership is granted by this file.
 *
 * `verifyCallback` therefore always refuses. There is no secret to check a
 * signature against, so there is no callback it could ever believe — and a
 * fallback that accepted an unsigned body would be exactly the hole this
 * whole change exists to close.
 */
export const manual: PaymentGateway = {
  provider: 'manual',
  label: 'Pay at the gym',

  // Always available: it is what is left when nothing else is set up.
  isConfigured: () => true,

  initiate: (input: InitiateInput): InitiateResult => ({
    // No redirect — the caller sees an empty url and shows "we'll confirm at
    // the front desk" instead of posting a form.
    url: '',
    fields: {},
    providerRef: input.intentId,
  }),

  verifyCallback: (): VerifyResult => ({
    ok: false,
    reason: 'manual payments are confirmed by staff, never by callback',
  }),
};
