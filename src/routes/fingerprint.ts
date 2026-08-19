/** @format */

import { Router } from "express";
import auth from "../middleware/auth.js";
import validate from "../middleware/validate.js";
import { requireStaff } from "../middleware/requireRole.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { authed } from "../types.js";
import {
  idParam,
  enrollFingerprintSchema,
  identifyFingerprintSchema,
} from "../schemas.js";
import {
  getStatus,
  capture,
  enroll,
  remove,
  identify,
} from "../controllers/fingerprintController.js";

const router = Router();

router.use(auth);
router.use(requireStaff);

router.get("/status", authed(getStatus));

/**
 * Identifying a finger is part of checking somebody in, so it takes the
 * check-in permission — the receptionist who may work the desk may work the
 * reader.
 */
router.post(
  "/identify",
  requirePermission("canCheckIn"),
  validate(identifyFingerprintSchema),
  authed(identify),
);

/**
 * Enrolment is not. Recording a member's biometric belongs with managing the
 * member, not with waving them through the door, so it sits behind
 * `canManageMembers` — which a receptionist does not have.
 *
 * `capture` takes the same permission as `enroll` rather than the weaker
 * check-in one: it is the first half of enrolling, and a reader that will take
 * a scan for anyone who can work the desk is a reader that can harvest
 * templates.
 */
router.post(
  "/capture",
  requirePermission("canManageMembers"),
  authed(capture),
);
router.post(
  "/enroll",
  requirePermission("canManageMembers"),
  validate(enrollFingerprintSchema),
  authed(enroll),
);
router.delete(
  "/:id",
  requirePermission("canManageMembers"),
  validate(idParam, "params"),
  authed(remove),
);

export default router;
