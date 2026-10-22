/** @format */

import { Router } from "express";
import auth from "../middleware/auth.js";
import validate from "../middleware/validate.js";
import { authed } from "../types.js";
import {
  bookMyClass,
  cancelMyBooking,
  getMyBookings,
  getMyMemberships,
  getMyProfile,
  getMyPurchases,
  getMySchedule,
  updateMyProfile,
} from "../controllers/meController.js";
import { selfCheckin } from "../controllers/attendanceController.js";
import { createMine, listMine, removeMine } from "../controllers/measurementsController.js";
import {
  bookMyClassSchema,
  createMeasurementSchema,
  idParam,
  myHistoryQuerySchema,
  myScheduleQuerySchema,
  selfCheckinSchema,
  updateMyProfileSchema,
} from "../schemas.js";

const router = Router();

/**
 * The member's own view of the gym.
 *
 * Deliberately not role-gated: any signed-in account may read or update its
 * own record, and every controller here scopes to the session's `memberId`
 * rather than to an id in the URL. That is the whole security argument for
 * this router — there is no id to tamper with, so "may this member see this?"
 * is a question none of these endpoints has to answer.
 *
 * An account with no member record (staff, owner) gets a 404 saying so, which
 * is truer than a 403: they are not forbidden, they are not a member.
 */
router.use(auth);

router.get("/", authed(getMyProfile));
router.put("/", validate(updateMyProfileSchema), authed(updateMyProfile));

router.get(
  "/memberships",
  validate(myHistoryQuerySchema, "query"),
  authed(getMyMemberships),
);
router.get(
  "/purchases",
  validate(myHistoryQuerySchema, "query"),
  authed(getMyPurchases),
);

// The timetable, and this member's place in it. Ahead of "/bookings/:id" so a
// literal path is never read as an id.
router.get(
  "/schedule",
  validate(myScheduleQuerySchema, "query"),
  authed(getMySchedule),
);
router.get(
  "/bookings",
  validate(myHistoryQuerySchema, "query"),
  authed(getMyBookings),
);
router.post("/bookings", validate(bookMyClassSchema), authed(bookMyClass));
// Cancelling frees the place for somebody else, which is why a member is
// trusted with it: a no-show holds a place nobody can use.
router.delete(
  "/bookings/:id",
  validate(idParam, "params"),
  authed(cancelMyBooking),
);

// Checking in by scanning the QR on the gym's screen. The token proves the
// phone was at the gym in the last couple of minutes; the session says who.
router.post("/checkin", validate(selfCheckinSchema), authed(selfCheckin));

// The member's own weigh-ins. They may log their own and take back what they
// logged; a measurement the gym recorded stays the gym's to remove.
router.get("/measurements", authed(listMine));
router.post(
  "/measurements",
  validate(createMeasurementSchema),
  authed(createMine),
);
router.delete(
  "/measurements/:id",
  validate(idParam, "params"),
  authed(removeMine),
);

export default router;
