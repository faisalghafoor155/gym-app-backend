import { Router } from "express";
import auth from "../middleware/auth.js";
import { requireStaff } from "../middleware/requireRole.js";
import { authed } from "../types.js";
import { getTrainerPayouts, markPayoutAsPaid } from "../controllers/payoutController.js";
import validate from "../middleware/validate.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { trainerIdParam } from "../schemas.js";

const router = Router();

router.use(auth);
router.use(requireStaff);

router.get("/", requirePermission("canViewPayments"), authed(getTrainerPayouts));
router.post(
  "/:trainerId/pay",
  requirePermission("canManagePayments"),
  validate(trainerIdParam, "params"),
  authed(markPayoutAsPaid),
);

export default router;

