import { Router } from "express";
import auth from "../middleware/auth.js";
import { requireStaff } from "../middleware/requireRole.js";
import { authed } from "../types.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { requireFeature } from "../middleware/requireFeature.js";
import { getAttendanceAnalytics } from "../controllers/analyticsController.js";

const router = Router();

router.use(auth);
router.use(requireStaff);

// Both gates, because they answer different questions: whether this person
// may see reports, and whether this gym's plan includes them.
router.get(
  "/attendance",
  requirePermission("canViewReports"),
  requireFeature("analytics"),
  authed(getAttendanceAnalytics),
);


export default router;
