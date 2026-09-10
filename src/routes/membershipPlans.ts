import { Router } from 'express';
import auth from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { requireStaff } from '../middleware/requireRole.js';
import { requirePermission } from '../middleware/requirePermission.js';
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

// Readable by any staff: selling a membership means picking a plan from this
// list, so a receptionist at the desk needs it.
router.get('/', validate(membershipPlanQuerySchema, 'query'), authed(getAll));

// Writing is `canManageMemberships` — the same permission the frontend already
// guards the /membership-plans page with, so the two agree rather than
// producing a page that opens and then refuses to save.
//
// It needs a guard at all because what a plan costs and how long it lasts is
// the price list: without one, a receptionist could sell a year for one rupee.
// Enforced here because hiding a page is not a guard — the endpoint answers
// whoever asks it, and the UI is only a suggestion to the browser.
router.post(
  '/',
  requirePermission('canManageMemberships'),
  validate(createMembershipPlanSchema),
  authed(create),
);
router.put(
  '/:id',
  requirePermission('canManageMemberships'),
  validate(idParam, 'params'),
  validate(updateMembershipPlanSchema),
  authed(update),
);
// Retires the plan rather than removing it; memberships sold under it still
// have to resolve.
router.delete(
  '/:id',
  requirePermission('canManageMemberships'),
  validate(idParam, 'params'),
  authed(deactivate),
);

export default router;
