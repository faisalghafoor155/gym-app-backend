import { Router } from 'express';
import auth from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { requireStaff, requireOwner } from '../middleware/requireRole.js';
import { authed } from '../types.js';
import {
  idParam, createSupplementSchema, updateSupplementSchema,
  sellSupplementSchema, restockSupplementSchema, salesReportQuerySchema,
} from '../schemas.js';
import {
  getAll, create, update, remove, sell, restock, salesReport,
} from '../controllers/supplementsController.js';

const router = Router();

router.use(auth);
router.use(requireStaff);

// Ahead of "/:id" so a literal path is never read as an id. Revenue is money,
// which is the owner's to see — the same rule the payments routes follow.
router.get(
  '/sales/report',
  requireOwner,
  validate(salesReportQuerySchema, 'query'),
  authed(salesReport),
);

router.get('/', authed(getAll));
router.post('/', validate(createSupplementSchema), authed(create));
router.put('/:id', validate(idParam, 'params'), validate(updateSupplementSchema), authed(update));
router.delete('/:id', validate(idParam, 'params'), authed(remove));

// Selling and restocking are front-desk work, so they stay with staff. What
// the gym earned from it is not.
router.post(
  '/:id/sell',
  validate(idParam, 'params'),
  validate(sellSupplementSchema),
  authed(sell),
);
router.post(
  '/:id/restock',
  validate(idParam, 'params'),
  validate(restockSupplementSchema),
  authed(restock),
);

export default router;
