/** @format */

import { Router } from "express";
import auth from "../middleware/auth.js";
import validate from "../middleware/validate.js";
import { requireOwner } from "../middleware/requireRole.js";
import { authed } from "../types.js";
import {
  idParam,
  createPaymentSchema,
  updatePaymentSchema,
  paymentQuerySchema,
} from "../schemas.js";
import {
  getAll,
  create,
  update,
  remove,
  getDue,
} from "../controllers/paymentsController.js";

const router = Router();

router.use(auth);
// Money is owner-only. Staff run the gym day to day but do not see what it
// takes in — gating it here rather than in the UI is what makes that real,
// since a hidden nav link is not access control.
router.use(requireOwner);
router.get("/", validate(paymentQuerySchema, "query"), authed(getAll));
router.post("/", validate(createPaymentSchema), authed(create));
// Ahead of "/:id" so a literal path is never read as an id.
router.get("/due", authed(getDue));
router.put(
  "/:id",
  validate(idParam, "params"),
  validate(updatePaymentSchema),
  authed(update),
);
router.delete("/:id", validate(idParam, "params"), authed(remove));

export default router;
