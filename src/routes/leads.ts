import { Router } from 'express';
import auth from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { requireStaff } from '../middleware/requireRole.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { authed } from '../types.js';
import {
  convertLeadSchema, createLeadSchema, idParam, leadQuerySchema, updateLeadSchema,
} from '../schemas.js';
import { convert, create, getAll, remove, update } from '../controllers/leadsController.js';

const router = Router();

router.use(auth);
router.use(requireStaff);

/**
 * Enquiries sit with member management: a lead is a member who has not
 * happened yet, and whoever may register the one may work the other.
 */
router.use(requirePermission('canManageMembers'));

router.get('/', validate(leadQuerySchema, 'query'), authed(getAll));
router.post('/', validate(createLeadSchema), authed(create));
router.put('/:id', validate(idParam, 'params'), validate(updateLeadSchema), authed(update));
router.delete('/:id', validate(idParam, 'params'), authed(remove));
router.post('/:id/convert', validate(idParam, 'params'), validate(convertLeadSchema), authed(convert));

export default router;
