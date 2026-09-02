/** @format */

import { Router } from "express";
import auth from "../middleware/auth.js";
import { requireStaff } from "../middleware/requireRole.js";
import { authed } from "../types.js";
import { getSubscription } from "../controllers/subscriptionController.js";

const router = Router();

router.use(auth);

/**
 * What this gym is on, what it may do, and how close it is to each ceiling.
 *
 * Staff rather than owner-only. The limits are not a financial figure — they
 * are the reason a button is missing, and a receptionist who cannot add the
 * 51st member needs to be told why rather than left with a form that fails.
 * What it costs is not here, because nothing in the app charges for it yet.
 *
 * There is no `PUT`. A plan changes when a gym pays, which happens out of
 * band, so moving one is an operator's job — `npx tsx scripts/setPlan.ts` —
 * and not something an owner can do to themselves from the settings page.
 */
router.get("/", requireStaff, authed(getSubscription));

export default router;
