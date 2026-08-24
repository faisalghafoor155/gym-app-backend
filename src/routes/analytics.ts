import { Router } from "express";
import auth from "../middleware/auth.js";
import { requireStaff } from "../middleware/requireRole.js";
import { authed } from "../types.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { getAttendanceAnalytics } from "../controllers/analyticsController.js";

const router = Router();

router.use(auth);
router.use(requireStaff);

router.get("/attendance", requirePermission("canViewReports"), authed(getAttendanceAnalytics));


export default router;
