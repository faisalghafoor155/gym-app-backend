import { Router } from 'express';
import auth from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { requireOwner, requireStaff } from '../middleware/requireRole.js';
import { authed } from '../types.js';
import {
  idParam, createStaffSchema, createMemberLoginSchema,
  updateUserSchema, transferOwnershipSchema,
} from '../schemas.js';
import {
  getAll, createStaff, createMemberLogin, update, remove, transferOwnership,
} from '../controllers/usersController.js';

const router = Router();

router.use(auth);

// Staff can see who has access, but only the owner can change it.
router.get('/', requireStaff, authed(getAll));

router.post('/staff', requireOwner, validate(createStaffSchema), authed(createStaff));
router.post('/member-login', requireOwner, validate(createMemberLoginSchema), authed(createMemberLogin));
router.post('/transfer-ownership', requireOwner, validate(transferOwnershipSchema), authed(transferOwnership));

router.put('/:id', requireOwner, validate(idParam, 'params'), validate(updateUserSchema), authed(update));
router.delete('/:id', requireOwner, validate(idParam, 'params'), authed(remove));

export default router;
