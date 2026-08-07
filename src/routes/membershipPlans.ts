import { Router } from 'express';
import auth from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { requireStaff } from '../middleware/requireRole.js';
import { authed } from '../types.js';
import {
  idParam, createMembershipPlanSchema, updateMembershipPlanSchema,
  membershipPlanQuerySchema,
} from '../schemas.js';
import {
  getAll, create, update, deactivate,
} from '../controllers/membershipPlansController.js';

const router = Router();

router.use(auth);
router.use(requireStaff);

router.get('/', validate(membershipPlanQuerySchema, 'query'), authed(getAll));
router.post('/', validate(createMembershipPlanSchema), authed(create));
router.put('/:id', validate(idParam, 'params'), validate(updateMembershipPlanSchema), authed(update));
// Retires the plan rather than removing it; memberships sold under it still
// have to resolve.
router.delete('/:id', validate(idParam, 'params'), authed(deactivate));

export default router;
