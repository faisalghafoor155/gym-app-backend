import { Router } from 'express';
import auth from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { authed } from '../types.js';
import {
  registerSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema,
  changePasswordSchema, googleAuthSchema,
} from '../schemas.js';
import {
  register, login, googleAuth, forgotPassword, resetPassword,
  changePassword, logout, logoutFallback, me,
} from '../controllers/authController.js';

const router = Router();

router.post('/register', validate(registerSchema), register);
router.post('/login', validate(loginSchema), login);
router.post('/google', validate(googleAuthSchema), googleAuth);
router.post('/forgot-password', validate(forgotPasswordSchema), forgotPassword);
router.post('/reset-password', validate(resetPasswordSchema), resetPassword);

// Logout has to know who is signing out in order to revoke their sessions, so
// it sits behind `auth`. An already-dead session is not an error worth showing
// the user, though — the cookie is cleared and the call reports success rather
// than leaving a stale cookie in the browser.
router.post('/logout', logoutFallback, auth, authed(logout));

router.get('/me', auth, authed(me));
router.post('/change-password', auth, validate(changePasswordSchema), authed(changePassword));

export default router;
