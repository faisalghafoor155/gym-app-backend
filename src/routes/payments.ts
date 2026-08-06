import { Router } from 'express';
import auth from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { requireStaff } from '../middleware/requireRole.js';
import { authed } from '../types.js';
import { createPaymentSchema, paymentQuerySchema } from '../schemas.js';
import { getAll, create, getDue } from '../controllers/paymentsController.js';

const router = Router();

router.use(auth);
router.use(requireStaff);
router.get('/', validate(paymentQuerySchema, 'query'), authed(getAll));
router.post('/', validate(createPaymentSchema), authed(create));
router.get('/due', authed(getDue));

export default router;
