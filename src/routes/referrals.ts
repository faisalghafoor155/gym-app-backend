import { Router } from 'express';
import auth from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { requireStaff } from '../middleware/requireRole.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { authed } from '../types.js';
import { grantReferralSchema, idParam, referralQuerySchema } from '../schemas.js';
import { cancel, getAll, grant } from '../controllers/referralsController.js';

const router = Router();

router.use(auth);
router.use(requireStaff);
// Referrals hang off registration, so they sit with member management.
router.use(requirePermission('canManageMembers'));

router.get('/', validate(referralQuerySchema, 'query'), authed(getAll));
router.post('/:id/grant', validate(idParam, 'params'), validate(grantReferralSchema), authed(grant));
router.post('/:id/cancel', validate(idParam, 'params'), authed(cancel));

export default router;
