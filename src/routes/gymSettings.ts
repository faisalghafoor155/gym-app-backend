import { Router } from 'express';
import auth from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { requireOwner, requireStaff } from '../middleware/requireRole.js';
import { authed } from '../types.js';
import { updateGymSettingsSchema } from '../schemas.js';
import { get, update } from '../controllers/gymSettingsController.js';

const router = Router();

router.use(auth);

// Staff read it — the front desk needs to know what a trainer assignment will
// bill before they make one. Only the owner sets prices.
router.get('/', requireStaff, authed(get));
router.put('/', requireOwner, validate(updateGymSettingsSchema), authed(update));

export default router;
