import { Router } from 'express';
import auth from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { requireStaff } from '../middleware/requireRole.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { authed } from '../types.js';
import {
  assignLockerSchema, createLockersSchema, idParam, updateLockerSchema,
} from '../schemas.js';
import {
  assign, create, getAll, release, releaseExpired, remove, update,
} from '../controllers/lockersController.js';

const router = Router();

router.use(auth);
router.use(requireStaff);
// Handing out a locker is the desk looking after a member.
router.use(requirePermission('canManageMembers'));

router.get('/', authed(getAll));
router.post('/', validate(createLockersSchema), authed(create));
// Ahead of "/:id" so the literal path is never read as an id.
router.post('/release-expired', authed(releaseExpired));
router.put('/:id', validate(idParam, 'params'), validate(updateLockerSchema), authed(update));
router.delete('/:id', validate(idParam, 'params'), authed(remove));
router.post('/:id/assign', validate(idParam, 'params'), validate(assignLockerSchema), authed(assign));
router.post('/:id/release', validate(idParam, 'params'), authed(release));

export default router;
