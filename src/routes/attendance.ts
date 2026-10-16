/** @format */

import { Router } from "express";
import auth from "../middleware/auth.js";
import validate from "../middleware/validate.js";
import { requireStaff } from "../middleware/requireRole.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { authed } from "../types.js";
import { idParam, checkinSchema } from "../schemas.js";
import {
  checkin,
  getGymQr,
  getToday,
  getMemberHistory,
} from "../controllers/attendanceController.js";

const router = Router();

router.use(auth);
router.use(requireStaff);
router.post(
  "/checkin",
  requirePermission("canCheckIn"),
  validate(checkinSchema),
  authed(checkin),
);
// The rotating QR members scan with their phones. Same permission as checking
// somebody in at the desk: the screen showing it is a way of doing exactly that.
router.get("/gym-qr", requirePermission("canCheckIn"), authed(getGymQr));
router.get("/today", authed(getToday));
router.get(
  "/member/:id",
  validate(idParam, "params"),
  authed(getMemberHistory),
);

export default router;
