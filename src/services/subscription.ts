/** @format */

import { Prisma, type GymPlan } from "@prisma/client";
export type { GymPlan };
import prisma from "../db.js";

/**
 * What each subscription tier is worth.
 *
 * **This file is the source of truth for limits and feature gating.** The
 * tiers themselves are an enum in the schema, because a gym is on exactly one
 * of three and a fourth value must not be storable; what a tier *entitles* a
 * gym to is here, because that is a pricing decision and pricing changes
 * without a migration.
 *
 * The client needs the same table to decide what to render — a page that
 * offers a button the server will refuse is worse than one that explains why
 * the button is missing — so it is generated from this file into
 * `frontend/src/utils/entitlements.generated.ts` by `npm run gen:permissions`,
 * exactly as `services/permissions.ts` already is. Change the table here, run
 * the generator, commit both; `tests/services/subscription.test.ts` fails if
 * the two fall out of step.
 */

/** A cap that is not one. Written as `null` rather than `Infinity` so it
 *  survives JSON on its way to the client, where `Infinity` becomes `null`
 *  anyway — better to say so once here than to discover it in the browser. */
export type Limit = number | null;

export interface PlanLimits {
  /**
   * How many members may be on the books at once.
   *
   * Counted over active members rather than every row ever created: a gym that
   * has been running for five years should not be pushed up a tier by people
   * who stopped coming in year one. That also makes the limit escapable
   * without deleting anybody — marking a lapsed member inactive frees a place.
   */
  members: Limit;
  /** Staff accounts, excluding the owner: they are the gym, not one of its
   *  helpers. */
  staff: Limit;
  /** Trainers on the books, active ones only — a trainer who has left does not
   *  occupy a place any more than a lapsed member does. */
  trainers: Limit;
  /** Classes in the catalogue. Schedules and bookings are uncapped: they are
   *  what a class is *for*, and capping them would cap the gym's timetable. */
  classes: Limit;
}

export interface PlanFeatures {
  /** Outgoing WhatsApp — welcome messages, receipts, expiry reminders. Costs
   *  real money per message, which is why it is not on the free tier. */
  whatsapp: boolean;
  /** Fingerprint enrolment and check-in. Needs hardware the gym has bought,
   *  and is the tier's headline feature. */
  biometrics: boolean;
  /** The reports pages — attendance trends, peak hours. */
  analytics: boolean;
  /** Taking membership payments through JazzCash or EasyPaisa. */
  onlinePayments: boolean;
}

export interface Entitlements {
  limits: PlanLimits;
  features: PlanFeatures;
}

/**
 * Everything off, every limit at nothing. Each tier below grants up from here,
 * so a capability absent from a tier is denied rather than accidentally
 * inherited — the same arrangement `permissions.ts` uses, for the same reason.
 */
const NOTHING: Entitlements = {
  limits: { members: 0, staff: 0, trainers: 0, classes: 0 },
  features: {
    whatsapp: false,
    biometrics: false,
    analytics: false,
    onlinePayments: false,
  },
};

export const ENTITLEMENTS: Record<GymPlan, Entitlements> = {
  /**
   * Enough to run a small gym and decide whether the app is worth paying for.
   *
   * The costly features are off, but nothing a gym needs to open its doors is:
   * members, memberships, attendance, payments at the counter, expenses and
   * the audit trail all work. Email reminders work too — they cost nothing to
   * send, and withholding them would leave the expiry job doing nothing at all
   * for a free gym, which reads as a broken feature rather than a withheld one.
   */
  free: {
    limits: { members: 50, staff: 2, trainers: 2, classes: 3 },
    features: { ...NOTHING.features },
  },

  /**
   * 200 active members tier. Starter plan.
   */
  basic: {
    limits: { members: 200, staff: 6, trainers: 10, classes: 20 },
    features: {
      ...NOTHING.features,
      whatsapp: true,
      analytics: true,
    },
  },

  /**
   * 400 active members tier. Growth plan.
   */
  growth: {
    limits: { members: 400, staff: 10, trainers: 20, classes: 35 },
    features: {
      ...NOTHING.features,
      whatsapp: true,
      analytics: true,
      onlinePayments: true,
    },
  },

  /** No ceiling on the roster, and the features that cost the gym real money
   *  to run: hardware at the door and money moving through the app. */
  pro: {
    limits: { members: null, staff: 25, trainers: null, classes: null },
    features: {
      whatsapp: true,
      biometrics: true,
      analytics: true,
      onlinePayments: true,
    },
  },
};

/** Display names, for the upgrade prompts and the settings page. */
export const PLAN_LABELS: Record<GymPlan, string> = {
  free: "Free",
  basic: "Basic",
  growth: "Growth",
  pro: "Pro",
};

/** The tiers in order, so "what would fix this" can walk upwards. */
export const PLAN_ORDER: readonly GymPlan[] = ["free", "basic", "growth", "pro"] as const;

export const entitlementsFor = (plan: GymPlan): Entitlements =>
  ENTITLEMENTS[plan] ?? NOTHING;

/** Whether a tier includes a feature. */
export const planHasFeature = (
  plan: GymPlan,
  feature: keyof PlanFeatures,
): boolean => entitlementsFor(plan).features[feature];

/** What a tier caps something at. `null` means uncapped. */
export const planLimitFor = (plan: GymPlan, of: keyof PlanLimits): Limit =>
  entitlementsFor(plan).limits[of];

/**
 * The cheapest tier that includes a feature, for the "upgrade to Pro" line.
 *
 * Returns `null` when no tier offers it, which cannot happen for a feature
 * named in `PlanFeatures` but is the honest answer rather than a lie about
 * Pro — a prompt telling somebody to buy a tier that would not help is worse
 * than one that says only that this tier cannot.
 */
export const cheapestPlanWith = (feature: keyof PlanFeatures): GymPlan | null =>
  PLAN_ORDER.find((p) => ENTITLEMENTS[p].features[feature]) ?? null;

/**
 * The cheapest tier whose cap on `of` is at least `needed`.
 *
 * Used to turn "you are at your limit" into "Basic would hold 300 of these",
 * which is the only version of that message a gym can act on.
 */
export const cheapestPlanFor = (
  of: keyof PlanLimits,
  needed: number,
): GymPlan | null =>
  PLAN_ORDER.find((p) => {
    const limit = ENTITLEMENTS[p].limits[of];
    return limit === null || limit >= needed;
  }) ?? null;

/**
 * The gym's tier, read from the database.
 *
 * Deliberately not carried on the session like the role is. A role is checked
 * on every request and changing one already bumps `tokenVersion`; a plan
 * changes when somebody pays, out of band, and a gym that has just upgraded
 * must not have to sign out before the thing they paid for starts working.
 */
export const planFor = async (gymId: string): Promise<GymPlan> => {
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
    select: { plan: true },
  });
  // A missing gym cannot happen behind `auth`, which resolved the gym to get
  // here. Falling back to the least-privileged answer rather than throwing
  // keeps a gating check from turning a vanished row into a 500.
  return gym?.plan ?? "free";
};

/** What currently counts against each limit. */
export const usageFor = async (gymId: string): Promise<Record<keyof PlanLimits, number>> => {
  const [members, staff, trainers, classes] = await Promise.all([
    prisma.member.count({ where: { gymId, status: "active" } }),
    prisma.user.count({ where: { gymId, role: "staff" } }),
    prisma.trainer.count({ where: { gymId, isActive: true } }),
    prisma.class.count({ where: { gymId } }),
  ]);
  return { members, staff, trainers, classes };
};

/** How a limit stands right now: what is used, what is allowed, what is left. */
export interface LimitStatus {
  limit: Limit;
  used: number;
  /** `null` when uncapped — "unlimited minus four" is not a number. */
  remaining: Limit;
}

const statusOf = (limit: Limit, used: number): LimitStatus => ({
  limit,
  used,
  remaining: limit === null ? null : Math.max(0, limit - used),
});

/**
 * The whole picture for one gym: its tier, what it may do, and how close it is
 * to each ceiling.
 *
 * One call rather than several because the client renders all of it together —
 * the settings page shows every bar at once, and the pages that gate a button
 * need the features beside the limits.
 */
export const subscriptionStatus = async (gymId: string) => {
  const [plan, usage] = await Promise.all([planFor(gymId), usageFor(gymId)]);
  const { limits, features } = entitlementsFor(plan);

  return {
    plan,
    planLabel: PLAN_LABELS[plan],
    features,
    limits: {
      members: statusOf(limits.members, usage.members),
      staff: statusOf(limits.staff, usage.staff),
      trainers: statusOf(limits.trainers, usage.trainers),
      classes: statusOf(limits.classes, usage.classes),
    },
  };
};

/**
 * Thrown when an action would take a gym past one of its limits.
 *
 * Carries what was hit and what would fix it, so the controller catching it
 * can say "Free holds 50 members; Basic holds 300" rather than "forbidden".
 * A limit a gym cannot see the shape of is one it cannot buy its way out of.
 */
export class PlanLimitError extends Error {
  constructor(
    readonly of: keyof PlanLimits,
    readonly plan: GymPlan,
    readonly limit: number,
  ) {
    super(`plan_limit:${of}`);
    this.name = "PlanLimitError";
  }

  /** The cheapest tier that would hold one more than the limit, if any. */
  get upgradeTo(): GymPlan | null {
    return cheapestPlanFor(this.of, this.limit + 1);
  }
}

/** Thrown when a gym's tier does not include a feature it tried to use. */
export class PlanFeatureError extends Error {
  constructor(
    readonly feature: keyof PlanFeatures,
    readonly plan: GymPlan,
  ) {
    super(`plan_feature:${feature}`);
    this.name = "PlanFeatureError";
  }

  get upgradeTo(): GymPlan | null {
    return cheapestPlanWith(this.feature);
  }
}

/** What each limit is called in a sentence a gym owner reads. */
const LIMIT_NOUNS: Record<keyof PlanLimits, string> = {
  members: "active members",
  staff: "staff accounts",
  trainers: "trainers",
  classes: "classes",
};

/** What each feature is called in the same sentence. */
const FEATURE_NOUNS: Record<keyof PlanFeatures, string> = {
  whatsapp: "WhatsApp messages",
  biometrics: "fingerprint check-in",
  analytics: "reports and analytics",
  onlinePayments: "online payments",
};

/**
 * Turns either error into the message and status the API answers with.
 *
 * `409` for a limit and `402` for a feature, which is the distinction a client
 * needs: a limit is a state the gym can change from inside the app — deactivate
 * a lapsed member and the place is free — while a missing feature can only be
 * bought. Answering both with the same code would leave the client unable to
 * tell "make room" from "upgrade".
 */
export const planErrorResponse = (
  err: PlanLimitError | PlanFeatureError,
): { status: number; body: Record<string, unknown> } => {
  const upgrade = err.upgradeTo;
  const upgradeLine = upgrade
    ? ` ${PLAN_LABELS[upgrade]} ${upgrade === "pro" && err instanceof PlanLimitError && planLimitFor("pro", err.of) === null ? "has no limit on them" : "allows more"}.`
    : "";

  if (err instanceof PlanFeatureError) {
    return {
      status: 402,
      body: {
        error:
          `${FEATURE_NOUNS[err.feature]} are not part of the ` +
          `${PLAN_LABELS[err.plan]} plan.` +
          (upgrade ? ` Upgrade to ${PLAN_LABELS[upgrade]} to use them.` : ""),
        reason: "plan_feature",
        feature: err.feature,
        plan: err.plan,
        upgradeTo: upgrade,
      },
    };
  }

  return {
    status: 409,
    body: {
      error:
        `The ${PLAN_LABELS[err.plan]} plan allows ${err.limit} ` +
        `${LIMIT_NOUNS[err.of]}, and all ${err.limit} are in use.` +
        upgradeLine,
      reason: "plan_limit",
      of: err.of,
      limit: err.limit,
      plan: err.plan,
      upgradeTo: upgrade,
    },
  };
};

/**
 * Claims one place against a limit, inside the caller's transaction.
 *
 * `SELECT ... FOR UPDATE` on the Gym row makes a second caller wait for the
 * first to commit before it counts, so the count it reads is the one it acts
 * on. Locking the gym rather than the rows being counted is deliberate: those
 * rows do not exist yet, so there is nothing else to take a lock on. This is
 * the same guard `claimStaffSeat` has always used for staff seats, generalised
 * — without it two receptionists adding the 50th and 51st member at the same
 * moment both pass the check and the gym ends up one over.
 *
 * Contention is per-gym and held for one insert, so two gyms never wait on
 * each other.
 */
export const claimPlace = async (
  tx: Prisma.TransactionClient,
  gymId: string,
  of: keyof PlanLimits,
  count: (tx: Prisma.TransactionClient) => Promise<number>,
): Promise<void> => {
  await tx.$queryRaw`SELECT id FROM "Gym" WHERE id = ${gymId} FOR UPDATE`;

  const gym = await tx.gym.findUnique({
    where: { id: gymId },
    select: { plan: true },
  });
  const plan = gym?.plan ?? "free";

  const limit = planLimitFor(plan, of);
  // Uncapped, so there is nothing to count. The lock above is still taken and
  // still released with the transaction — cheap, and it keeps this one code
  // path rather than two that could drift.
  if (limit === null) return;

  // Counted inside the transaction, behind the lock, so it sees what a
  // concurrent caller has already committed.
  const used = await count(tx);
  if (used >= limit) throw new PlanLimitError(of, plan, limit);
};

/**
 * Refuses an action whose feature the gym's tier does not include.
 *
 * Throws rather than returning a boolean so a caller cannot forget to check
 * the answer — the same reason the limit guard throws.
 */
export const requireFeature = async (
  gymId: string,
  feature: keyof PlanFeatures,
): Promise<void> => {
  const plan = await planFor(gymId);
  if (!planHasFeature(plan, feature)) {
    throw new PlanFeatureError(feature, plan);
  }
};
