import { Router } from 'express';
import auth from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { requireStaff } from '../middleware/requireRole.js';
import { authed } from '../types.js';
import { idParam, checkinSchema } from '../schemas.js';
import { checkin, getToday, getMemberHistory } from '../controllers/attendanceController.js';

const router = Router();

router.use(auth);
router.use(requireStaff);
router.post('/checkin', validate(checkinSchema), authed(checkin));
router.get('/today', authed(getToday));
router.get('/member/:id', validate(idParam, 'params'), authed(getMemberHistory));

export default router;
