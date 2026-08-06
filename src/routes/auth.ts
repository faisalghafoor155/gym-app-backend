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
  changePassword, logout, me,
} from '../controllers/authController.js';

const router = Router();

router.post('/register', validate(registerSchema), register);
router.post('/login', validate(loginSchema), login);
router.post('/google', validate(googleAuthSchema), googleAuth);
router.post('/forgot-password', validate(forgotPasswordSchema), forgotPassword);
router.post('/reset-password', validate(resetPasswordSchema), resetPassword);

router.post('/logout', logout);

router.get('/me', auth, authed(me));
router.post('/change-password', auth, validate(changePasswordSchema), authed(changePassword));

export default router;
