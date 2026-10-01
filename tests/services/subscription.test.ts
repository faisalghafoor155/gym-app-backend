import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ENTITLEMENTS,
  PLAN_LABELS,
  PLAN_ORDER,
  cheapestPlanFor,
  cheapestPlanWith,
  entitlementsFor,
  planHasFeature,
  planLimitFor,
  PlanFeatureError,
  PlanLimitError,
  planErrorResponse,
} from '../../src/services/subscription.js';
import { OUTPUT, render } from '../../scripts/generateEntitlements.js';

/**
 * The guard that keeps the client's copy of the pricing table honest.
 *
 * Same arrangement as the permission table, for a sharper reason: a client that
 * disagrees with the server about what a gym has paid for either offers a
 * button the server refuses, or hides one the gym is entitled to. Both read as
 * a bug in the product rather than as a stale file.
 */
describe('the entitlements table', () => {
  it('the committed client copy matches its source', () => {
    const committed = readFileSync(OUTPUT, 'utf8');
    // If this fails, run `npm run gen:permissions` in backend/ and commit the
    // result — do not edit the generated file by hand.
    expect(committed.replace(/\r\n/g, '\n')).toBe(render().replace(/\r\n/g, '\n'));
  });

  it('every tier has an entry and a label', () => {
    for (const plan of PLAN_ORDER) {
      expect(ENTITLEMENTS[plan], plan).toBeDefined();
      expect(PLAN_LABELS[plan], plan).toBeTruthy();
    }
  });

  it('every tier defines every limit and every feature', () => {
    // `undefined` is falsy and `undefined >= n` is false, so a missing key
    // would deny or cap by accident rather than by decision.
    const limitKeys = Object.keys(ENTITLEMENTS.free.limits).sort();
    const featureKeys = Object.keys(ENTITLEMENTS.free.features).sort();

    for (const plan of PLAN_ORDER) {
      const { limits, features } = ENTITLEMENTS[plan];
      expect(Object.keys(limits).sort(), `${plan} limits`).toEqual(limitKeys);
      expect(Object.keys(features).sort(), `${plan} features`).toEqual(featureKeys);

      for (const [key, value] of Object.entries(limits)) {
        expect(value === null || typeof value === 'number', `${plan}.${key}`).toBe(true);
      }
      for (const [key, value] of Object.entries(features)) {
        expect(typeof value, `${plan}.${key}`).toBe('boolean');
      }
    }
  });

  it('never takes something away as a gym pays more', () => {
    // A tier that withdrew a feature or lowered a cap would make upgrading a
    // downgrade for somebody — the kind of thing that is obvious in a table
    // and invisible in a diff.
    for (let i = 1; i < PLAN_ORDER.length; i++) {
      const lower = ENTITLEMENTS[PLAN_ORDER[i - 1]!];
      const higher = ENTITLEMENTS[PLAN_ORDER[i]!];
      const where = `${PLAN_ORDER[i - 1]} → ${PLAN_ORDER[i]}`;

      for (const key of Object.keys(lower.limits) as (keyof typeof lower.limits)[]) {
        const a = lower.limits[key];
        const b = higher.limits[key];
        // null is uncapped, so it beats every number and ties with itself.
        const notWorse = b === null || (a !== null && b >= a);
        expect(notWorse, `${where} lowers ${key}`).toBe(true);
      }

      for (const key of Object.keys(lower.features) as (keyof typeof lower.features)[]) {
        if (lower.features[key]) {
          expect(higher.features[key], `${where} removes ${key}`).toBe(true);
        }
      }
    }
  });
});

describe('what a tier is worth', () => {
  it('free withholds every paid feature', () => {
    expect(Object.values(ENTITLEMENTS.free.features).some(Boolean)).toBe(false);
  });

  it('basic keeps the six staff seats every gym used to get', () => {
    // The figure was hardcoded for everyone before plans existed. Basic is
    // sized so nothing a gym was already doing stopped working.
    expect(planLimitFor('basic', 'staff')).toBe(6);
  });

  it('pro leaves the roster uncapped', () => {
    expect(planLimitFor('pro', 'members')).toBeNull();
    expect(planLimitFor('pro', 'trainers')).toBeNull();
    expect(planLimitFor('pro', 'classes')).toBeNull();
  });

  it('gates the features that cost money to run', () => {
    expect(planHasFeature('free', 'whatsapp')).toBe(false);
    expect(planHasFeature('basic', 'whatsapp')).toBe(true);

    // Hardware and money moving through the app are the Pro line.
    expect(planHasFeature('basic', 'biometrics')).toBe(false);
    expect(planHasFeature('pro', 'biometrics')).toBe(true);
    expect(planHasFeature('basic', 'onlinePayments')).toBe(false);
    expect(planHasFeature('pro', 'onlinePayments')).toBe(true);
  });

  it('falls back to nothing for a tier it does not know', () => {
    // Cannot happen behind the enum, but the fallback must deny rather than
    // grant — an unrecognised plan is not a licence.
    const unknown = entitlementsFor('nonsense' as never);
    expect(Object.values(unknown.features).some(Boolean)).toBe(false);
    expect(unknown.limits.members).toBe(0);
  });
});

describe('what would fix it', () => {
  it('names the cheapest tier that includes a feature', () => {
    expect(cheapestPlanWith('whatsapp')).toBe('basic');
    expect(cheapestPlanWith('biometrics')).toBe('pro');
    expect(cheapestPlanWith('analytics')).toBe('basic');
  });

  it('names the cheapest tier that would hold the count', () => {
    expect(cheapestPlanFor('members', 51)).toBe('basic');
    expect(cheapestPlanFor('members', 201)).toBe('growth');
    expect(cheapestPlanFor('members', 401)).toBe('pro');
    // Uncapped holds anything.
    expect(cheapestPlanFor('members', 10_000)).toBe('pro');
  });

  it('says so honestly when no tier is big enough', () => {
    // Staff is capped even on Pro, so asking for more than Pro allows has no
    // answer — and a prompt naming a tier that would not help is worse than
    // one that names none.
    expect(cheapestPlanFor('staff', 26)).toBeNull();
  });
});

describe('how a refusal reads', () => {
  it('answers 409 for a limit — a state the gym can change itself', () => {
    const { status, body } = planErrorResponse(
      new PlanLimitError('members', 'free', 50),
    );

    expect(status).toBe(409);
    expect(body.reason).toBe('plan_limit');
    expect(body.of).toBe('members');
    expect(body.upgradeTo).toBe('basic');
    // The numbers a gym needs to act are in the sentence, not just the fields.
    expect(body.error).toContain('50');
    expect(body.error).toContain('Free');
  });

  it('answers 402 for a feature — something only money fixes', () => {
    const { status, body } = planErrorResponse(
      new PlanFeatureError('biometrics', 'free'),
    );

    expect(status).toBe(402);
    expect(body.reason).toBe('plan_feature');
    expect(body.feature).toBe('biometrics');
    expect(body.upgradeTo).toBe('pro');
    expect(body.error).toContain('Pro');
  });

  it('does not promise an upgrade that would not help', () => {
    const { body } = planErrorResponse(new PlanLimitError('staff', 'pro', 25));

    expect(body.upgradeTo).toBeNull();
    // No "upgrade to" clause, because there is nothing to upgrade to.
    expect(body.error).not.toContain('allows more');
  });
});
