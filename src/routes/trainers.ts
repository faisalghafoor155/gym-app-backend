import { Router } from "express";
import auth from "../middleware/auth.js";
import validate from "../middleware/validate.js";
import { requireStaff } from "../middleware/requireRole.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { authed } from "../types.js";
import {
  idParam, createTrainerSchema, updateTrainerSchema, trainerQuerySchema,
} from "../schemas.js";
import { getAll, create, update, remove } from "../controllers/trainersController.js";

const router = Router();

router.use(auth);
router.use(requireStaff);

router.get("/", validate(trainerQuerySchema, "query"), authed(getAll));

router.post(
  "/",
  requirePermission("canManageTrainers"),
  validate(createTrainerSchema),
  authed(create),
);

router.put(
  "/:id",
  requirePermission("canManageTrainers"),
  validate(idParam, "params"),
  validate(updateTrainerSchema),
  authed(update),
);

router.delete(
  "/:id",
  requirePermission("canManageTrainers"),
  validate(idParam, "params"),
  authed(remove),
);

export default router;
