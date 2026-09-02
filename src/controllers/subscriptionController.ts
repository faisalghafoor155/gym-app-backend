/** @format */

import type { Response } from "express";
import type { AuthedRequest } from "../types.js";
import {
  ENTITLEMENTS,
  PLAN_LABELS,
  PLAN_ORDER,
  subscriptionStatus,
} from "../services/subscription.js";

/**
 * The gym's tier, its entitlements, and how much of each limit is used.
 *
 * The whole table comes back alongside, not just this gym's row. A gym at its
 * ceiling is about to be asked to upgrade, and "Basic holds 300 members" is
 * the only version of that ask it can act on — sending only the current tier
 * would leave the client inventing the numbers or hard-coding a second copy of
 * them.
 */
export const getSubscription = async (
  req: AuthedRequest,
  res: Response,
): Promise<void> => {
  try {
    const status = await subscriptionStatus(req.gymId);

    res.json({
      ...status,
      plans: PLAN_ORDER.map((plan) => ({
        plan,
        label: PLAN_LABELS[plan],
        ...ENTITLEMENTS[plan],
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};
