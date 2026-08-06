import { Router } from 'express';
import auth from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { requireStaff } from '../middleware/requireRole.js';
import { authed } from '../types.js';
import { idParam, createSupplementSchema, updateSupplementSchema } from '../schemas.js';
import { getAll, create, update, remove } from '../controllers/supplementsController.js';

const router = Router();

router.use(auth);
router.use(requireStaff);
router.get('/', authed(getAll));
router.post('/', validate(createSupplementSchema), authed(create));
router.put('/:id', validate(idParam, 'params'), validate(updateSupplementSchema), authed(update));
router.delete('/:id', validate(idParam, 'params'), authed(remove));

export default router;
