import { Router } from 'express';
import auth from '../middleware/auth.js';
import { requireStaff } from '../middleware/requireRole.js';
import { authed } from '../types.js';
import { getCelebrations, getStats } from '../controllers/dashboardController.js';

const router = Router();

router.use(auth);
router.use(requireStaff);
router.get('/', authed(getStats));
router.get('/celebrations', authed(getCelebrations));

export default router;
