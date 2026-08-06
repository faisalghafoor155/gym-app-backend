import { Router } from 'express';
import auth from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { requireStaff } from '../middleware/requireRole.js';
import { authed } from '../types.js';
import { idParam, createPlanSchema, assignPlanSchema } from '../schemas.js';
import {
  getWorkoutPlans, createWorkoutPlan,
  getDietPlans, createDietPlan,
  assignPlan, getMemberPlans,
} from '../controllers/plansController.js';

const router = Router();

router.use(auth);
router.use(requireStaff);
router.get('/workout', authed(getWorkoutPlans));
router.post('/workout', validate(createPlanSchema), authed(createWorkoutPlan));
router.get('/diet', authed(getDietPlans));
router.post('/diet', validate(createPlanSchema), authed(createDietPlan));
router.post('/assign', validate(assignPlanSchema), authed(assignPlan));
router.get('/member/:id', validate(idParam, 'params'), authed(getMemberPlans));

export default router;
