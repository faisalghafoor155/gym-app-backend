import type { PaymentProvider } from '@prisma/client';

/**
 * What every payment provider has to look like from the application's side.
 *
 * The two halves are deliberately asymmetric. `initiate` builds a form the
 * member's browser posts to the provider — it is allowed to know prices and
 * order ids. `verifyCallback` is handed whatever the provider sent back, over
 * an unauthenticated public endpoint, and must decide whether to believe it.
 * Everything a gateway can get wrong lives in that second method, so it is the
 * one worth reading twice.
 */

/** What the browser needs in order to hand the member over to the provider. */
export interface InitiateResult {
  /** Where to POST. */
  url: string;
  /** Hidden form fields, already signed. */
  fields: Record<string, string>;
  /** The provider's id for this attempt, stored so its callback can be matched
   *  back to the intent that started it. */
  providerRef: string;
}

/** What a gateway is willing to swear to after checking a callback. */
export type VerifyResult =
  | {
      ok: true;
      /** The intent this callback settles. */
      providerRef: string;
      /**
       * What the provider says was actually paid, in rupees. The caller
       * compares this against the stored intent amount — a gateway never gets
       * to decide that a smaller number is close enough.
       */
      amount: number;
      /** Whether the provider is reporting success or a declined payment. */
      paid: boolean;
      /** The provider's own message, for a failed payment. */
      failureReason?: string;
    }
  | {
      ok: false;
      /** Why the callback was not believed. Logged, never shown to the caller:
       *  telling an attacker which check failed helps them pass it. */
      reason: string;
    };

export interface InitiateInput {
  /** Our intent id, round-tripped through the provider as the order reference. */
  intentId: string;
  /** Rupees, exactly what the member must pay. */
  amount: number;
  /** Shown on the provider's page. */
  description: string;
  /** Where the provider should send the member's browser afterwards. */
  returnUrl: string;
}

export interface PaymentGateway {
  readonly provider: PaymentProvider;
  /** Human name for the provider picker. */
  readonly label: string;
  /**
   * Whether this gateway has the credentials it needs. A gateway missing its
   * secrets is not offered rather than failing at the moment a member tries to
   * pay — and, more importantly, is never allowed to verify a callback, since
   * a gateway with no secret cannot distinguish a real one from a forgery.
   */
  isConfigured(): boolean;
  initiate(input: InitiateInput): Promise<InitiateResult> | InitiateResult;
  /**
   * Decides whether a callback body genuinely came from the provider.
   *
   * Must return `ok: false` rather than throwing for anything it does not
   * believe: a malformed body from the open internet is an expected input
   * here, not an exceptional one.
   */
  verifyCallback(body: Record<string, unknown>): VerifyResult;
}
