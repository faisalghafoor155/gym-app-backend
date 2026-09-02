import { Router } from "express";
import auth from "../middleware/auth.js";
import validate from "../middleware/validate.js";
import { requireStaff } from "../middleware/requireRole.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { authed } from "../types.js";
import {
  idParam, createClassSchema, createClassScheduleSchema, classQuerySchema,
} from "../schemas.js";
import { getAll, create, getSchedules, createSchedule, deleteSchedule } from "../controllers/classesController.js";

const router = Router();

router.use(auth);
router.use(requireStaff);

router.get("/", validate(classQuerySchema, "query"), authed(getAll));
router.get("/schedules", authed(getSchedules));

router.post(
  "/",
  requirePermission("canManageClasses"),
  validate(createClassSchema),
  authed(create),
);

router.post(
  "/schedules",
  requirePermission("canManageClasses"),
  validate(createClassScheduleSchema),
  authed(createSchedule),
);

router.delete(
  "/schedules/:id",
  requirePermission("canManageClasses"),
  validate(idParam, "params"),
  authed(deleteSchedule),
);

export default router;
