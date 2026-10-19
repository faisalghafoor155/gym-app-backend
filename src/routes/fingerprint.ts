/** @format */

import { Router } from "express";
import auth from "../middleware/auth.js";
import validate from "../middleware/validate.js";
import { requireStaff } from "../middleware/requireRole.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { requireFeature } from "../middleware/requireFeature.js";
import { authed } from "../types.js";
import {
  idParam,
  enrollFingerprintSchema,
  identifyFingerprintSchema,
  deviceEnrolSchema,
} from "../schemas.js";
import {
  getStatus,
  capture,
  enroll,
  startDeviceEnrol,
  confirmDeviceEnrol,
  remove,
  identify,
} from "../controllers/fingerprintController.js";

const router = Router();

router.use(auth);
router.use(requireStaff);

/**
 * Deliberately ungated. The Attendance tab asks this on every load to decide
 * what to render, and a 402 here would leave it unable to tell "no reader is
 * plugged in" from "your plan does not include one" — which are the two things
 * this endpoint exists to distinguish. The controller reports the plan instead,
 * so the page can offer an upgrade rather than a broken tab.
 */
router.get("/status", authed(getStatus));

/**
 * Identifying a finger is part of checking somebody in, so it takes the
 * check-in permission — the receptionist who may work the desk may work the
 * reader.
 */
router.post(
  "/identify",
  requirePermission("canCheckIn"),
  requireFeature("biometrics"),
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
  requireFeature("biometrics"),
  authed(capture),
);
router.post(
  "/enroll",
  requirePermission("canManageMembers"),
  requireFeature("biometrics"),
  validate(enrollFingerprintSchema),
  authed(enroll),
);
/** Enrolment on a reader that takes the finger itself — same gate as `enroll`. */
router.post(
  "/device-enrol/start",
  requirePermission("canManageMembers"),
  requireFeature("biometrics"),
  validate(deviceEnrolSchema),
  authed(startDeviceEnrol),
);
router.post(
  "/device-enrol/confirm",
  requirePermission("canManageMembers"),
  requireFeature("biometrics"),
  validate(deviceEnrolSchema),
  authed(confirmDeviceEnrol),
);
/**
 * Not gated, unlike enrolment. A gym that downgrades still holds the templates
 * it took, and deleting one is the *disposal* of a biometric — the one thing a
 * member may always ask for and the one thing a plan must never stand between
 * them and. Refusing this on a downgrade would trap fingerprints in the
 * database with no way to remove them short of deleting the member.
 */
router.delete(
  "/:id",
  requirePermission("canManageMembers"),
  validate(idParam, "params"),
  authed(remove),
);

export default router;
