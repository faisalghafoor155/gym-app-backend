import { Router } from 'express';
import auth from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { requireStaff, requireOwner } from '../middleware/requireRole.js';
import { authed } from '../types.js';
import {
  idParam, membershipParams, createMemberSchema, updateMemberSchema,
  createMembershipSchema, extendMembershipSchema,
} from '../schemas.js';
import { getAll, getOne, create, update, remove } from '../controllers/membersController.js';
import {
  getHistory as getMembershipHistory,
  create as createMembership,
  extend as extendMembership,
} from '../controllers/membershipsController.js';

const router = Router();

router.use(auth);
router.use(requireStaff);

router.get('/', authed(getAll));
router.post('/', validate(createMemberSchema), authed(create));
router.get('/:id', validate(idParam, 'params'), authed(getOne));
router.put('/:id', validate(idParam, 'params'), validate(updateMemberSchema), authed(update));
router.delete('/:id', validate(idParam, 'params'), authed(remove));

// Memberships belong to a member, so they hang off one — the id in the path is
// what scopes them, and the controller checks it against this gym.
router.get('/:id/memberships', validate(idParam, 'params'), authed(getMembershipHistory));
router.post(
  '/:id/memberships',
  validate(idParam, 'params'),
  validate(createMembershipSchema),
  authed(createMembership),
);

// Owner-only, unlike everything else on this router: granting free days is
// spending the gym's money, so it sits with payments and staff accounts rather
// than with day-to-day front-desk work. The router-level requireStaff is not
// enough on its own, hence the second guard here.
router.post(
  '/:id/memberships/:membershipId/extend',
  requireOwner,
  validate(membershipParams, 'params'),
  validate(extendMembershipSchema),
  authed(extendMembership),
);

export default router;
