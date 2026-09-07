import type { PaymentProvider } from '@prisma/client';
import type { PaymentGateway } from './types.js';
import { makeJazzcash } from './jazzcash.js';
import { makeEasypaisa } from './easypaisa.js';
import { manual } from './manual.js';

/**
 * The gateways *we* collect subscription money through.
 *
 * A deliberately separate registry from `index.ts`, which is the gym's. The
 * two answer different questions — "how may this gym's members pay it" versus
 * "how may this gym pay us" — and the credentials behind them belong to
 * different companies. Sharing one registry would mean a gym that wires up
 * JazzCash for its members silently gaining the ability to settle its own
 * invoices against its own merchant account, which is not a payment at all.
 *
 * The prefix is what keeps them apart: `PLATFORM_JAZZCASH_MERCHANT_ID` rather
 * than `JAZZCASH_MERCHANT_ID`. Nothing else about the protocol differs, which
 * is why these are the same implementations rather than copies of them.
 */
const PREFIX = 'PLATFORM_';

const ALL: readonly PaymentGateway[] = [
  makeJazzcash(PREFIX),
  makeEasypaisa(PREFIX),
  // Bank transfer, cash, a cheque — settled by an operator running the script
  // rather than by a callback. Named `manual` because that is what the enum
  // calls it; the column has to hold something and inventing a fourth value
  // for the same idea would only be a second thing to check for.
  manual,
];

const BY_PROVIDER = new Map<PaymentProvider, PaymentGateway>(
  ALL.map((g) => [g.provider, g]),
);

export const getPlatformGateway = (
  provider: PaymentProvider,
): PaymentGateway | undefined => BY_PROVIDER.get(provider);

/**
 * What a gym owner may actually pick to pay their invoice.
 *
 * `manual` only when nothing real is configured, matching `availableGateways`:
 * offering "pay by bank transfer" beside a working card button trains owners
 * to take the route that needs a human to reconcile it.
 */
export const availablePlatformGateways = (): PaymentGateway[] => {
  const real = ALL.filter((g) => g.provider !== 'manual' && g.isConfigured());
  return real.length > 0 ? real : [manual];
};

/**
 * Whether subscriptions can be collected online at all. Said once at boot, so
 * an operator learns it from a deploy rather than from a gym that cannot pay.
 */
export const hasPlatformGateway = (): boolean =>
  ALL.some((g) => g.provider !== 'manual' && g.isConfigured());
