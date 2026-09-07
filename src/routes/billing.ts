/** @format */

import { Router } from "express";
import express from "express";
import auth from "../middleware/auth.js";
import validate from "../middleware/validate.js";
import { requireOwner } from "../middleware/requireRole.js";
import { authed } from "../types.js";
import {
  providerParams,
  subscribeSchema,
  subscriptionCheckoutSchema,
} from "../schemas.js";
import {
  getBilling,
  subscribe,
  checkoutInvoice,
  handleCallback,
  handleReturn,
} from "../controllers/billingController.js";

const router = Router();

/**
 * The provider endpoints are mounted *before* `auth`, deliberately — and,
 * unusually, they must also work for a gym that is currently suspended.
 *
 * A provider calling back server-to-server carries no session cookie, so
 * putting these behind `auth` would reject every real callback and leave every
 * subscription payment stuck. Their authentication is the signature over the
 * body, which proves the *provider* sent it rather than merely that somebody
 * is signed in.
 *
 * The suspension point is the one that matters here. `auth` refuses a
 * suspended gym with a 403 — which is right for every other route, and exactly
 * wrong for this one: a gym suspended for non-payment is precisely the gym
 * whose payment needs to land. Behind `auth` these routes would take the money
 * and never lift the suspension it was paid to lift.
 *
 * Providers post `application/x-www-form-urlencoded`, which the app-wide JSON
 * parser does not handle, so these bring their own.
 */
const form = express.urlencoded({ extended: false });

router.post(
  "/callback/:provider",
  form,
  validate(providerParams, "params"),
  handleCallback,
);
// Some providers only ever GET the return URL, with their fields in the query.
router.get("/return/:provider", validate(providerParams, "params"), handleReturn);
router.post(
  "/return/:provider",
  form,
  validate(providerParams, "params"),
  handleReturn,
);

router.use(auth);

/**
 * Owner-only, all of it.
 *
 * `GET /subscription` is staff-visible because limits explain why a button is
 * missing, which a receptionist needs. What the gym *pays* is a different
 * question with a different audience: it is the owner's money, and a
 * receptionist has no reason to see the invoice history or a card form.
 */
router.get("/", requireOwner, authed(getBilling));

router.post(
  "/subscribe",
  requireOwner,
  validate(subscribeSchema),
  authed(subscribe),
);

router.post(
  "/checkout",
  requireOwner,
  validate(subscriptionCheckoutSchema),
  authed(checkoutInvoice),
);

export default router;
