/** @format */

import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import validate from "../middleware/validate.js";
import type { AuthedRequest } from "../types.js";
import {
  generateTwoFactorSecret,
  enableTwoFactor,
  disableTwoFactor,
  saveTempTwoFactorSecret,
  verifyTOTPCode,
  getBackupCodeCount,
  readTwoFactorSecret,
  regenerateBackupCodes,
} from "../services/twoFactor.js";
import { verifyTwoFactorLogin } from "../controllers/authController.js";
import prisma from "../db.js";

const router = Router();

/**
 * GET /api/auth/two-factor/setup
 * Generate a new 2FA secret and QR code for setup
 */
router.get("/setup", requireAuth, async (req, res: Response) => {
  const authReq = req as AuthedRequest;
  try {
    const user = await prisma.user.findUnique({
      where: { id: authReq.userId },
      select: { email: true, twoFactorEnabled: true },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    if (user.twoFactorEnabled) {
      res.status(400).json({
        error: "2FA is already enabled. Disable it first to set up again.",
      });
      return;
    }

    const { secret, qrCode, backupCodes } = await generateTwoFactorSecret(
      user.email,
    );

    // Save temporary secret
    await saveTempTwoFactorSecret(authReq.userId, secret, backupCodes);

    res.json({
      secret,
      qrCode,
      backupCodes,
    });
  } catch (error) {
    console.error("2FA setup error:", error);
    res.status(500).json({ error: "Failed to generate 2FA setup" });
  }
});

/**
 * POST /api/auth/two-factor/verify-setup
 * Verify TOTP code and enable 2FA
 */
// No backup codes in the body: the server hashed and stored the ones it issued
// at /setup, so the client has no say in which codes end up protecting the
// account. Older clients that still send the field are ignored, not rejected.
const verifySetupSchema = z.object({
  code: z.string().regex(/^\d{6}$/, "Code must be 6 digits"),
});

router.post(
  "/verify-setup",
  requireAuth,
  validate(verifySetupSchema),
  async (req, res: Response) => {
    const authReq = req as AuthedRequest<
      Record<string, string>,
      unknown,
      { code: string }
    >;
    try {
      const { code } = authReq.body;

      const user = await prisma.user.findUnique({
        where: { id: authReq.userId },
        select: {
          twoFactorTempSecret: true,
          twoFactorTempSecretAt: true,
          twoFactorTempBackupCodes: true,
        },
      });

      if (!user?.twoFactorTempSecret || !user.twoFactorTempBackupCodes) {
        res
          .status(400)
          .json({ error: "No 2FA setup in progress. Call /setup first." });
        return;
      }

      // Temp secret expires after 15 minutes
      const tempSecretAge =
        Date.now() - (user.twoFactorTempSecretAt?.getTime() ?? 0);
      if (tempSecretAge > 15 * 60 * 1000) {
        res
          .status(400)
          .json({ error: "2FA setup expired. Please start over." });
        return;
      }

      // Decrypted once and used for both the check and the write below, so the
      // column can be encrypted without either forgetting.
      const tempSecret = readTwoFactorSecret(
        user.twoFactorTempSecret,
        authReq.userId,
      );

      // Verify the code
      if (!verifyTOTPCode(tempSecret, code)) {
        res.status(400).json({ error: "Invalid code. Please try again." });
        return;
      }

      // Enable 2FA
      await enableTwoFactor(
        authReq.userId,
        tempSecret,
        user.twoFactorTempBackupCodes,
      );

      res.json({ success: true, message: "2FA enabled successfully" });
    } catch (error) {
      console.error("2FA verification error:", error);
      res.status(500).json({ error: "Failed to enable 2FA" });
    }
  },
);

/**
 * POST /api/auth/two-factor/verify-login
 * The second half of signing in. Public because the caller has no session
 * yet — what they hold is the challenge token /auth/login (or /auth/google)
 * issued after the first factor passed. The controller lives with the other
 * session-issuing code in authController.
 *
 * Rate-limited like every credential endpoint (see index.ts): the challenge
 * proves the password, so guessing codes here must not be free.
 */
const verifyLoginSchema = z.object({
  token: z.string().min(1),
  // Six digits from the authenticator, or a backup code in its xxxx-xxxx
  // shape — checked loosely here and decided by shape in the controller.
  code: z.string().min(1),
});

router.post(
  "/verify-login",
  validate(verifyLoginSchema),
  (req, res) => verifyTwoFactorLogin(req, res),
);

/**
 * GET /api/auth/two-factor/status
 * What the security settings page needs to render: on or off, and how many
 * backup codes remain before the user should regenerate them.
 */
router.get("/status", requireAuth, async (req, res: Response) => {
  const authReq = req as AuthedRequest;
  try {
    const user = await prisma.user.findUnique({
      where: { id: authReq.userId },
      select: { twoFactorEnabled: true },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({
      enabled: user.twoFactorEnabled,
      remainingBackupCodes: user.twoFactorEnabled
        ? await getBackupCodeCount(authReq.userId)
        : 0,
    });
  } catch (error) {
    console.error("2FA status error:", error);
    res.status(500).json({ error: "Failed to load 2FA status" });
  }
});

/**
 * POST /api/auth/two-factor/backup-codes
 * Issues a fresh set of backup codes, invalidating the previous set.
 *
 * The codes are single-use and shown once, so an account that has spent them
 * is one lost phone away from being locked out. Before this the only remedy
 * was to disable 2FA and set it up again, which means a window with the
 * protection off and a new QR to re-scan everywhere.
 *
 * Password-gated for the same reason as disabling: a stolen session cookie
 * must not be able to mint itself a set of credentials that bypass the second
 * factor — that would hand the attacker exactly what 2FA exists to withhold,
 * and unlike disabling it, the theft would leave the protection apparently
 * still on.
 */
router.post(
  "/backup-codes",
  requireAuth,
  validate(z.object({ password: z.string().min(1, "is required") })),
  async (req, res: Response) => {
    const authReq = req as AuthedRequest<unknown, unknown, { password: string }>;
    try {
      const user = await prisma.user.findUnique({
        where: { id: authReq.userId },
        select: { passwordHash: true, twoFactorEnabled: true },
      });

      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      // Nothing to replace, and issuing codes that bypass a factor which is
      // not switched on would be a set of spare keys to an unlocked door.
      if (!user.twoFactorEnabled) {
        res.status(400).json({ error: "2FA is not enabled on this account" });
        return;
      }

      if (
        !user.passwordHash ||
        !(await bcrypt.compare(authReq.body.password, user.passwordHash))
      ) {
        res.status(401).json({ error: "Incorrect password" });
        return;
      }

      const backupCodes = await regenerateBackupCodes(authReq.userId);
      res.json({ backupCodes });
    } catch (error) {
      console.error("2FA backup code regeneration error:", error);
      res.status(500).json({ error: "Failed to regenerate backup codes" });
    }
  },
);

/**
 * DELETE /api/auth/two-factor
 * Disable 2FA for the current user. Requires the account password.
 *
 * A session cookie alone used to be enough, which made the second factor worth
 * very little: anyone holding a stolen 30-day cookie could take it off in one
 * request and keep the account. Re-entering the password is what makes turning
 * the protection off cost as much as the protection was worth — the attacker
 * with the cookie is precisely the one who does not have it.
 *
 * A TOTP code is deliberately not accepted here instead. Somebody who has lost
 * their authenticator is the most likely person to be disabling 2FA, and
 * demanding a code from the device they no longer have would leave them locked
 * out of their own account with no way back.
 */
router.delete(
  "/",
  requireAuth,
  validate(z.object({ password: z.string().min(1, "is required") })),
  async (req, res: Response) => {
    const authReq = req as AuthedRequest<unknown, unknown, { password: string }>;
    try {
      const user = await prisma.user.findUnique({
        where: { id: authReq.userId },
        select: { passwordHash: true, twoFactorEnabled: true },
      });

      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      if (!user.twoFactorEnabled) {
        res.status(400).json({ error: "2FA is not enabled on this account" });
        return;
      }

      // An account created by invite and never completed has no password, so
      // there is nothing to check against. It also cannot have enabled 2FA,
      // but the guard is here rather than assumed.
      if (
        !user.passwordHash ||
        !(await bcrypt.compare(authReq.body.password, user.passwordHash))
      ) {
        res.status(401).json({ error: "Incorrect password" });
        return;
      }

      await disableTwoFactor(authReq.userId);
      res.json({ success: true, message: "2FA disabled" });
    } catch (error) {
      console.error("2FA disable error:", error);
      res.status(500).json({ error: "Failed to disable 2FA" });
    }
  },
);

export default router;
