/** @format */

import { Router } from "express";
import auth from "../middleware/auth.js";
import validate from "../middleware/validate.js";
import { requireStaff, requireOwner } from "../middleware/requireRole.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { authed } from "../types.js";
import {
  idParam,
  createSupplementSchema,
  updateSupplementSchema,
  sellSupplementSchema,
  checkoutCartSchema,
  restockSupplementSchema,
  salesReportQuerySchema,
  supplementQuerySchema,
} from "../schemas.js";
import {
  getAll,
  create,
  update,
  remove,
  sell,
  checkoutCart,
  restock,
  salesReport,
  exportSalesCsv,
} from "../controllers/supplementsController.js";

const router = Router();

router.use(auth);
router.use(requireStaff);

// Ahead of "/:id" so a literal path is never read as an id. Revenue is money,
// which is the owner's to see — the same rule the payments routes follow.
router.get(
  "/sales/export",
  requireOwner,
  validate(salesReportQuerySchema, "query"),
  authed(exportSalesCsv),
);
router.get(
  "/sales/report",
  requireOwner,
  validate(salesReportQuerySchema, "query"),
  authed(salesReport),
);

router.get("/", validate(supplementQuerySchema, "query"), authed(getAll));
router.post(
  "/",
  requirePermission("canManageSupplements"),
  validate(createSupplementSchema),
  authed(create),
);
router.put(
  "/:id",
  requirePermission("canManageSupplements"),
  validate(idParam, "params"),
  validate(updateSupplementSchema),
  authed(update),
);
router.delete(
  "/:id",
  requirePermission("canManageSupplements"),
  validate(idParam, "params"),
  authed(remove),
);

// Selling and restocking are front-desk work, so they stay with staff. What
// the gym earned from it is not.
router.post(
  "/:id/sell",
  requirePermission("canSellSupplements"),
  validate(idParam, "params"),
  validate(sellSupplementSchema),
  authed(sell),
);
router.post(
  "/:id/restock",
  requirePermission("canManageSupplements"),
  validate(idParam, "params"),
  validate(restockSupplementSchema),
  authed(restock),
);

router.post(
  "/checkout-pos",
  requirePermission("canSellSupplements"),
  validate(checkoutCartSchema),
  authed(checkoutCart),
);

export default router;
