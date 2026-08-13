/** @format */

import { Router } from "express";
import auth from "../middleware/auth.js";
import validate from "../middleware/validate.js";
import { requireOwner, requireStaff } from "../middleware/requireRole.js";
import { authed } from "../types.js";
import {
  idParam,
  createPaymentSchema,
  updatePaymentSchema,
  paymentQuerySchema,
  paymentSummaryQuerySchema,
  monthlyCollectionQuerySchema,
} from "../schemas.js";
import {
  getAll,
  create,
  update,
  remove,
  getDue,
  getSummary,
  getMonthlyCollection,
} from "../controllers/paymentsController.js";

const router = Router();

router.use(auth);
router.use(requireStaff);

// Taking a fee is front-desk work: whoever is on the counter has to be able to
// record what a member just handed over, and see who still owes. So the two
// calls the counter needs are staff-level.
//
// Reading the books is not. `getAll` still runs for staff, but the controller
// narrows it to the rows that staff member recorded themselves — their own
// day's takings, not the gym's. The split lives in the controller rather than
// in a second route because it is one list with one shape; only its scope
// changes.
router.post("/", validate(createPaymentSchema), authed(create));
router.get("/", validate(paymentQuerySchema, "query"), authed(getAll));
// Ahead of "/:id" so a literal path is never read as an id.
router.get("/due", authed(getDue));

// The gym's totals, and correcting the record afterwards. Both are the owner's:
// a month's grand total is the books, and an entry that can be edited or
// deleted by whoever took it is not a record of anything.
router.get(
  "/summary",
  requireOwner,
  validate(paymentSummaryQuerySchema, "query"),
  authed(getSummary),
);
// Who paid in a given month, as opposed to how much the month brought in.
// Owner-only for the same reason as the summary: it is the gym's collection,
// not one staff member's counter.
router.get(
  "/monthly",
  requireOwner,
  validate(monthlyCollectionQuerySchema, "query"),
  authed(getMonthlyCollection),
);
router.put(
  "/:id",
  requireOwner,
  validate(idParam, "params"),
  validate(updatePaymentSchema),
  authed(update),
);
router.delete("/:id", requireOwner, validate(idParam, "params"), authed(remove));

export default router;
