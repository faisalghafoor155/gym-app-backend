import { Router } from "express";
import auth from "../middleware/auth.js";
import validate from "../middleware/validate.js";
import { requireStaff } from "../middleware/requireRole.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { authed } from "../types.js";
import { idParam, createClassBookingSchema, updateClassBookingSchema } from "../schemas.js";
import { getAll, create, update } from "../controllers/classBookingsController.js";

const router = Router();

router.use(auth);
router.use(requireStaff);

router.get("/", authed(getAll));

router.post(
  "/",
  requirePermission("canManageClasses"),
  validate(createClassBookingSchema),
  authed(create),
);

router.put(
  "/:id",
  requirePermission("canManageClasses"),
  validate(idParam, "params"),
  validate(updateClassBookingSchema),
  authed(update),
);

export default router;
