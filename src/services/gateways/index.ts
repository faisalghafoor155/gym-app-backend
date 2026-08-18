import type { PaymentProvider } from '@prisma/client';
import type { PaymentGateway } from './types.js';
import { jazzcash } from './jazzcash.js';
import { easypaisa } from './easypaisa.js';
import { manual } from './manual.js';

export type { PaymentGateway, VerifyResult, InitiateResult } from './types.js';

/**
 * Every gateway the application knows how to speak to.
 *
 * Adding a provider means writing one file against `PaymentGateway` and adding
 * it here plus to the `PaymentProvider` enum — nothing in the controller,
 * routes or UI needs to know the name. That is the point of the registry: the
 * checkout flow is written once and the providers are data.
 */
const ALL: readonly PaymentGateway[] = [jazzcash, easypaisa, manual];

const BY_PROVIDER = new Map<PaymentProvider, PaymentGateway>(
  ALL.map((g) => [g.provider, g]),
);

export const getGateway = (provider: PaymentProvider): PaymentGateway | undefined =>
  BY_PROVIDER.get(provider);

/**
 * The gateways a member may actually pick right now.
 *
 * `manual` is offered only when it is the last resort: showing "pay at the
 * gym" next to a working JazzCash button trains members to bypass the gateway,
 * and the front desk ends up reconciling by hand anyway.
 */
export const availableGateways = (): PaymentGateway[] => {
  const real = ALL.filter((g) => g.provider !== 'manual' && g.isConfigured());
  return real.length > 0 ? real : [manual];
};

/**
 * Whether any real provider is wired up. Used at boot to say so once in the
 * log, rather than leaving an operator to discover it from a member's
 * complaint that renewals never complete.
 */
export const hasLiveGateway = (): boolean =>
  ALL.some((g) => g.provider !== 'manual' && g.isConfigured());
