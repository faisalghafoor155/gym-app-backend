/** @format */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  ENTITLEMENTS,
  PLAN_LABELS,
  PLAN_ORDER,
  type Entitlements,
} from '../src/services/subscription.js';

/**
 * Writes the client's copy of the subscription table from the server's.
 *
 * Same arrangement as `generatePermissions.ts`, for the same reason: the client
 * has to know what a tier is worth to render an upgrade prompt that names real
 * numbers, and a second hand-maintained copy of a pricing table is a copy that
 * will disagree with the server about what somebody has paid for. The server
 * table is the only one anybody edits;
 * `tests/services/subscription.test.ts` fails the build if the committed output
 * stops matching.
 *
 * Run with `npm run gen:permissions`, which generates both files.
 */

const HEADER = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Written from backend/src/services/subscription.ts by
 * backend/scripts/generateEntitlements.ts. Change the table there and run
 * \`npm run gen:permissions\` in backend/, then commit both files.
 *
 * The backend test suite fails if this stops matching its source.
 */`;

/** `null` is an uncapped limit and has to survive as `null`, not as a number. */
const renderLimit = (value: number | null): string =>
  value === null ? 'null' : String(value);

const renderEntitlement = (e: Entitlements): string => {
  const limits = Object.entries(e.limits)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `      ${key}: ${renderLimit(value as number | null)},`)
    .join('\n');

  const features = Object.entries(e.features)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `      ${key}: ${String(value)},`)
    .join('\n');

  return `    limits: {\n${limits}\n    },\n    features: {\n${features}\n    },`;
};

const sampleEntitlement = ENTITLEMENTS[PLAN_ORDER[0]!];

const limitFields = Object.keys(sampleEntitlement.limits)
  .sort()
  .map((key) => `  ${key}: Limit;`)
  .join('\n');

const featureFields = Object.keys(sampleEntitlement.features)
  .sort()
  .map((key) => `  ${key}: boolean;`)
  .join('\n');

const plans = PLAN_ORDER.map(
  (plan) => `  ${plan}: {\n${renderEntitlement(ENTITLEMENTS[plan])}\n  },`,
).join('\n');

const labels = PLAN_ORDER.map(
  (plan) => `  ${plan}: ${JSON.stringify(PLAN_LABELS[plan])},`,
).join('\n');

export const render = (): string => `${HEADER}

import type { GymPlan } from '../types';

/** \`null\` means uncapped — see the server table for why not \`Infinity\`. */
export type Limit = number | null;

export interface PlanLimits {
${limitFields}
}

export interface PlanFeatures {
${featureFields}
}

export interface Entitlements {
  limits: PlanLimits;
  features: PlanFeatures;
}

/** The tiers, cheapest first. */
export const PLAN_ORDER: readonly GymPlan[] = [${PLAN_ORDER.map((p) => `'${p}'`).join(', ')}] as const;

export const ENTITLEMENTS: Record<GymPlan, Entitlements> = {
${plans}
};

export const PLAN_LABELS: Record<GymPlan, string> = {
${labels}
};
`;

const OUTPUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../frontend/src/utils/entitlements.generated.ts',
);

// Only writes when run directly, so the test can import `render` and compare
// without rewriting the file it is checking.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  writeFileSync(OUTPUT, render(), 'utf8');
  console.log(`Wrote ${OUTPUT}`);
}

export { OUTPUT };
