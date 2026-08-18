import { Router } from 'express';
import auth from '../middleware/auth.js';
import { authed } from '../types.js';
import { getPlans, checkout } from '../controllers/onlinePaymentsController.js';

const router = Router();

router.use(auth);

router.get('/plans', authed(getPlans));
router.post('/checkout', authed(checkout));

export default router;
