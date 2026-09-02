import { Router } from 'express';
import auth from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { requireOwner } from '../middleware/requireRole.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { authed } from '../types.js';
import {
  idParam, createStaffSchema, createMemberLoginSchema,
  updateUserSchema, transferOwnershipSchema, userQuerySchema,
} from '../schemas.js';
import {
  getAll, createStaff, createMemberLogin, update, remove, transferOwnership,
} from '../controllers/usersController.js';

const router = Router();

router.use(auth);

// Staff list and creating accounts is for the owner and anyone with the
// 'canManageStaff' permission (usually a Manager).
router.get(
  '/',
  requirePermission('canManageStaff'),
  validate(userQuerySchema, 'query'),
  authed(getAll),
);

router.post('/staff', requirePermission('canManageStaff'), validate(createStaffSchema), authed(createStaff));
router.post('/member-login', requirePermission('canManageStaff'), validate(createMemberLoginSchema), authed(createMemberLogin));

// Transferring the whole gym is strictly the owner's.
router.post('/transfer-ownership', requireOwner, validate(transferOwnershipSchema), authed(transferOwnership));

router.put('/:id', requirePermission('canModifyStaff'), validate(idParam, 'params'), validate(updateUserSchema), authed(update));
router.delete('/:id', requirePermission('canModifyStaff'), validate(idParam, 'params'), authed(remove));

export default router;
