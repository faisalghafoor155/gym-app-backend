import { Router } from 'express';
import auth from '../middleware/auth.js';
import { requireStaff } from '../middleware/requireRole.js';
import { authed } from '../types.js';
import { getStats } from '../controllers/dashboardController.js';

const router = Router();

router.use(auth);
router.use(requireStaff);
router.get('/', authed(getStats));

export default router;
