import { Router } from 'express';
import auth from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { requireStaff } from '../middleware/requireRole.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { authed } from '../types.js';
import {
  createExpenseSchema, expenseQuerySchema, idParam, profitQuerySchema, updateExpenseSchema,
} from '../schemas.js';
import { getAll, create, update, remove, getProfit } from '../controllers/expensesController.js';

const router = Router();

router.use(auth);
router.use(requireStaff);

/**
 * Expenses are the gym's books, so the whole module sits behind one
 * permission: the owner, a manager, or an accountant. A receptionist who can
 * see what a member paid has no business seeing the rent, and unlike payments
 * there is no per-row narrowing that would make a partial view meaningful —
 * an expense belongs to the gym, not to whoever typed it in.
 */
router.use(requirePermission('canManageExpenses'));

router.get('/', validate(expenseQuerySchema, 'query'), authed(getAll));
router.get('/profit', validate(profitQuerySchema, 'query'), authed(getProfit));

router.post('/', validate(createExpenseSchema), authed(create));
router.put('/:id', validate(idParam, 'params'), validate(updateExpenseSchema), authed(update));
router.delete('/:id', validate(idParam, 'params'), authed(remove));

export default router;
