import { Router } from 'express';
import auth from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { requireStaff } from '../middleware/requireRole.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { authed } from '../types.js';
import {
  checkPromoQuerySchema, createPromoCodeSchema, idParam, updatePromoCodeSchema,
} from '../schemas.js';
import { check, create, getAll, remove, update } from '../controllers/promoCodesController.js';

const router = Router();

router.use(auth);
router.use(requireStaff);

// Checking a code is counter work — whoever sells the membership asks.
router.get('/check', validate(checkPromoQuerySchema, 'query'), authed(check));

// Deciding the offers is pricing, which sits with the membership plans.
router.get('/', requirePermission('canManageMemberships'), authed(getAll));
router.post('/', requirePermission('canManageMemberships'), validate(createPromoCodeSchema), authed(create));
router.put(
  '/:id',
  requirePermission('canManageMemberships'),
  validate(idParam, 'params'),
  validate(updatePromoCodeSchema),
  authed(update),
);
router.delete('/:id', requirePermission('canManageMemberships'), validate(idParam, 'params'), authed(remove));

export default router;
