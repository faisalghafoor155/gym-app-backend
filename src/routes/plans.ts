import { Router } from 'express';
import auth from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { requireStaff } from '../middleware/requireRole.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { authed } from '../types.js';
import { idParam, createPlanSchema, assignPlanSchema } from '../schemas.js';
import {
  getWorkoutPlans, createWorkoutPlan,
  getDietPlans, createDietPlan,
  assignPlan, getMemberPlans, deleteWorkoutPlan, deleteDietPlan,
} from '../controllers/plansController.js';

const router = Router();

router.use(auth);
router.use(requireStaff);
// Reading stays open to any staff: a trainer or the front desk may need to
// look up what a member has been given.
router.get('/workout', authed(getWorkoutPlans));
router.get('/diet', authed(getDietPlans));
router.get('/member/:id', validate(idParam, 'params'), authed(getMemberPlans));

// Writing and assigning is `canManagePlans`, the same permission the frontend
// guards the /plans page with. Without it here the page was hidden from a
// receptionist while the endpoints behind it stayed open to one — a guard in
// the browser is a suggestion, not an authorisation.
router.post(
  '/workout',
  requirePermission('canManagePlans'),
  validate(createPlanSchema),
  authed(createWorkoutPlan),
);
router.post(
  '/diet',
  requirePermission('canManagePlans'),
  validate(createPlanSchema),
  authed(createDietPlan),
);
router.delete(
  '/workout/:id',
  requirePermission('canManagePlans'),
  validate(idParam, 'params'),
  authed(deleteWorkoutPlan),
);
router.delete(
  '/diet/:id',
  requirePermission('canManagePlans'),
  validate(idParam, 'params'),
  authed(deleteDietPlan),
);
router.post(
  '/assign',
  requirePermission('canManagePlans'),
  validate(assignPlanSchema),
  authed(assignPlan),
);

export default router;
