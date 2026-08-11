import { Router } from 'express';
import auth from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { requireOwner } from '../middleware/requireRole.js';
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

// Every route here is the owner's: who can sign in to the gym, and what they
// may do. The list alone carries each account's name, email and role, which is
// not something the front desk needs to run the day — so it is gated with the
// rest rather than left open. Enforced here rather than only by hiding the
// page, because a hidden nav link is not access control.
router.use(requireOwner);

router.get('/', authed(getAll));

router.post('/staff', validate(createStaffSchema), authed(createStaff));
router.post('/member-login', validate(createMemberLoginSchema), authed(createMemberLogin));
router.post('/transfer-ownership', validate(transferOwnershipSchema), authed(transferOwnership));

router.put('/:id', validate(idParam, 'params'), validate(updateUserSchema), authed(update));
router.delete('/:id', validate(idParam, 'params'), authed(remove));

export default router;
