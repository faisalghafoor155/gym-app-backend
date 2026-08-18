import { Router } from 'express';
import express from 'express';
import auth from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { requireStaff } from '../middleware/requireRole.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { authed } from '../types.js';
import { checkoutSchema, idParam, providerParams } from '../schemas.js';
import {
  getPlans,
  getProviders,
  checkout,
  handleCallback,
  handleReturn,
  confirmManual,
  myIntents,
  pendingManual,
} from '../controllers/onlinePaymentsController.js';

const router = Router();

/**
 * The provider endpoints are mounted *before* `auth`, deliberately.
 *
 * A payment provider calling back server-to-server carries no session cookie —
 * putting these behind `auth` would reject every real callback and leave every
 * payment stuck as pending. Their authentication is the signature over the
 * body, checked in the gateway, which is a stronger claim than a session
 * cookie would be here: it proves the *provider* sent it, not merely that
 * somebody is logged in.
 *
 * Providers post `application/x-www-form-urlencoded`, which the app-wide JSON
 * parser does not handle, so these routes bring their own.
 */
const form = express.urlencoded({ extended: false });

router.post('/callback/:provider', form, validate(providerParams, 'params'), handleCallback);
// Some providers only ever GET the return URL with fields in the query string.
router.get('/return/:provider', validate(providerParams, 'params'), handleReturn);
router.post('/return/:provider', form, validate(providerParams, 'params'), handleReturn);

router.use(auth);

router.get('/plans', authed(getPlans));
router.get('/providers', authed(getProviders));
router.get('/my-intents', authed(myIntents));
router.post('/checkout', validate(checkoutSchema), authed(checkout));

/**
 * Settling a front-desk request is taking money, so it needs the same
 * permission as recording any other payment — not merely being staff.
 */
router.get('/pending-manual', requireStaff, requirePermission('canRecordPayments'), authed(pendingManual));
router.post(
  '/:id/confirm',
  requireStaff,
  requirePermission('canRecordPayments'),
  validate(idParam, 'params'),
  authed(confirmManual),
);

export default router;
