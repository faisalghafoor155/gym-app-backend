import { Router } from 'express';
import auth from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { requireOwner } from '../middleware/requireRole.js';
import { authed } from '../types.js';
import { auditLogQuerySchema } from '../schemas.js';
import { getAll } from '../controllers/auditLogsController.js';

const router = Router();

router.use(auth);
// The log names which member of staff did what — that is the owner's to read.
router.use(requireOwner);

router.get('/', validate(auditLogQuerySchema, 'query'), authed(getAll));

export default router;
