/** @format */

import { Router } from "express";
import auth from "../middleware/auth.js";
import validate from "../middleware/validate.js";
import { requireStaff, requireOwner } from "../middleware/requireRole.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { authed } from "../types.js";
import {
  idParam,
  membershipParams,
  createMemberSchema,
  updateMemberSchema,
  memberQuerySchema,
  memberDuplicateQuerySchema,
  importMembersSchema,
  createMembershipSchema,
  renewMembershipSchema,
  membershipHistoryQuerySchema,
  freezeMembershipSchema,
  createMeasurementSchema,
  measurementParams,
} from "../schemas.js";
import {
  listForMember as listMeasurements,
  createForMember as createMeasurement,
  removeForMember as removeMeasurement,
} from "../controllers/measurementsController.js";
import {
  getAll,
  getOne,
  create,
  update,
  checkDuplicate,
  importMembers,
  remove,
} from "../controllers/membersController.js";
import {
  getHistory as getMembershipHistory,
  create as createMembership,
  renew as renewMembership,
  suspend as suspendMembership,
  resume as resumeMembership,
  cancel as cancelMembership,
  freeze as freezeMembership,
  unfreeze as unfreezeMembership,
} from "../controllers/membershipsController.js";

const router = Router();

router.use(auth);
router.use(requireStaff);

router.get("/", validate(memberQuerySchema, "query"), authed(getAll));
router.post(
  "/import",
  requirePermission("canManageMembers"),
  validate(importMembersSchema),
  authed(importMembers),
);
router.post(
  "/",
  requirePermission("canManageMembers"),
  validate(createMemberSchema),
  authed(create),
);
// Ahead of `/:id`, which would otherwise match "check-duplicate" and send it
// to getOne as a member id.
router.get(
  "/check-duplicate",
  validate(memberDuplicateQuerySchema, "query"),
  authed(checkDuplicate),
);
router.get("/:id", validate(idParam, "params"), authed(getOne));
router.put(
  "/:id",
  requirePermission("canManageMembers"),
  validate(idParam, "params"),
  validate(updateMemberSchema),
  authed(update),
);
router.delete(
  "/:id",
  requirePermission("canManageMembers"),
  validate(idParam, "params"),
  authed(remove),
);

// Memberships belong to a member, so they hang off one — the id in the path is
// what scopes them, and the controller checks it against this gym.
router.get(
  "/:id/memberships",
  validate(idParam, "params"),
  validate(membershipHistoryQuerySchema, "query"),
  authed(getMembershipHistory),
);
router.post(
  "/:id/memberships",
  requirePermission("canManageMemberships"),
  validate(idParam, "params"),
  validate(createMembershipSchema),
  authed(createMembership),
);

// Front-desk work, not owner-only: renewing is taking money the member owes
// and selling them the next period, which is exactly what the desk is for.
router.post(
  "/:id/memberships/:membershipId/renew",
  requirePermission("canManageMemberships"),
  validate(membershipParams, "params"),
  validate(renewMembershipSchema),
  authed(renewMembership),
);

// Pausing and calling off a membership. Same permission as selling one: these
// are counter decisions, and whoever can take the money can also stop it.
router.post(
  "/:id/memberships/:membershipId/suspend",
  requirePermission("canManageMemberships"),
  validate(membershipParams, "params"),
  authed(suspendMembership),
);
router.post(
  "/:id/memberships/:membershipId/resume",
  requirePermission("canManageMemberships"),
  validate(membershipParams, "params"),
  authed(resumeMembership),
);
router.post(
  "/:id/memberships/:membershipId/cancel",
  requirePermission("canManageMemberships"),
  validate(membershipParams, "params"),
  authed(cancelMembership),
);

// Stopping the clock for travel or injury, and starting it again early. Same
// permission as suspending: both are the desk changing a membership in hand.
router.post(
  "/:id/memberships/:membershipId/freeze",
  requirePermission("canManageMemberships"),
  validate(membershipParams, "params"),
  validate(freezeMembershipSchema),
  authed(freezeMembership),
);
router.post(
  "/:id/memberships/:membershipId/unfreeze",
  requirePermission("canManageMemberships"),
  validate(membershipParams, "params"),
  authed(unfreezeMembership),
);

// Weigh-ins. Any staff member can read them — a trainer on the floor needs
// the numbers — but recording or removing one is member management.
router.get(
  "/:id/measurements",
  validate(idParam, "params"),
  authed(listMeasurements),
);
router.post(
  "/:id/measurements",
  requirePermission("canManageMembers"),
  validate(idParam, "params"),
  validate(createMeasurementSchema),
  authed(createMeasurement),
);
router.delete(
  "/:id/measurements/:measurementId",
  requirePermission("canManageMembers"),
  validate(measurementParams, "params"),
  authed(removeMeasurement),
);

export default router;
