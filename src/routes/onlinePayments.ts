import { Router } from 'express';
import express from 'express';
import auth from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { requireStaff } from '../middleware/requireRole.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireFeature } from '../middleware/requireFeature.js';
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
/**
 * Starting a checkout is the one action gated by the plan. The callback and
 * return routes above are deliberately not — they are mounted before `auth`
 * and carry a provider's signature rather than a session, and a gym that
 * downgraded while a member was mid-payment must still be able to complete
 * the payment that member has already made. Refusing a callback would take
 * their money and never credit the membership.
 *
 * `confirmManual` below is likewise ungated: it settles a request the front
 * desk is holding cash for, which is not an online payment at all.
 */
router.post(
  '/checkout',
  requireFeature('onlinePayments'),
  validate(checkoutSchema),
  authed(checkout),
);

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
