import { Router } from "express";
import auth from "../middleware/auth.js";
import validate from "../middleware/validate.js";
import { requireStaff } from "../middleware/requireRole.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { authed } from "../types.js";
import {
  idParam, createPtSessionSchema, updatePtSessionSchema, ptSessionQuerySchema,
} from "../schemas.js";
import { getAll, create, update, getCommissionsReport } from "../controllers/ptSessionsController.js";

const router = Router();

router.use(auth);
router.use(requireStaff);

router.get("/", validate(ptSessionQuerySchema, "query"), authed(getAll));

router.get("/commissions", requirePermission("canManageTrainers"), authed(getCommissionsReport));

router.post(
  "/",
  requirePermission("canManageTrainers"),
  validate(createPtSessionSchema),
  authed(create),
);

router.put(
  "/:id",
  requirePermission("canManageTrainers"),
  validate(idParam, "params"),
  validate(updatePtSessionSchema),
  authed(update),
);

export default router;
