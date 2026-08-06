import { Router } from 'express';
import auth from '../middleware/auth.js';
import { authed } from '../types.js';
import { getMyProfile } from '../controllers/meController.js';

const router = Router();

// Deliberately not role-gated: any signed-in account may read its own record,
// and the controller scopes everything to the session's memberId.
router.use(auth);
router.get('/', authed(getMyProfile));

export default router;
