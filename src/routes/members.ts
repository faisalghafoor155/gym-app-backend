import { Router } from 'express';
import auth from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { requireStaff } from '../middleware/requireRole.js';
import { authed } from '../types.js';
import { idParam, createMemberSchema, updateMemberSchema } from '../schemas.js';
import { getAll, create, update, remove } from '../controllers/membersController.js';

const router = Router();

router.use(auth);
router.use(requireStaff);
router.get('/', authed(getAll));
router.post('/', validate(createMemberSchema), authed(create));
router.put('/:id', validate(idParam, 'params'), validate(updateMemberSchema), authed(update));
router.delete('/:id', validate(idParam, 'params'), authed(remove));

export default router;
