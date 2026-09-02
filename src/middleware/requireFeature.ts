/** @format */

import type { Request, Response, NextFunction } from "express";
import {
  planErrorResponse,
  planFor,
  planHasFeature,
  PlanFeatureError,
  type PlanFeatures,
} from "../services/subscription.js";
import type { AuthedRequest } from "../types.js";

/**
 * Gates a route to gyms whose subscription includes a feature.
 *
 * Mounted after `auth`, which is what puts the gym on the request. Answers
 * `402 Payment Required` rather than `403`: the caller's *permissions* are
 * fine — a manager asking for reports is entitled to reports — and what is
 * missing is the gym's plan. A client can tell the two apart, which is the
 * whole point: a 403 means "you cannot", a 402 means "the gym has not bought
 * this", and only the second has an upgrade button under it.
 *
 * Sits alongside `requirePermission` rather than replacing it, because they
 * answer different questions and a route usually needs both: *may this person
 * do it* and *has this gym paid for it*. Owners bypass permissions; nobody
 * bypasses a plan.
 */
export const requireFeature =
  (feature: keyof PlanFeatures) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const { gymId } = req as AuthedRequest;

    void planFor(gymId)
      .then((plan) => {
        if (planHasFeature(plan, feature)) {
          next();
          return;
        }
        const { status, body } = planErrorResponse(
          new PlanFeatureError(feature, plan),
        );
        res.status(status).json(body);
      })
      .catch((err: unknown) => {
        console.error(err);
        res.status(500).json({ error: "Server error" });
      });
  };

export default requireFeature;
