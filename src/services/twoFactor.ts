/** @format */

import crypto from "node:crypto";
import speakeasy from "speakeasy";
import QRCode from "qrcode";
import bcryptjs from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../db.js";
import { encryptSecret, decryptSecret } from "./secretBox.js";
import type { JwtPayload } from "../types.js";

/**
 * Two-Factor Authentication service using TOTP (Time-based One-Time Password)
 */

export interface TwoFactorSetupResult {
  secret: string;
  qrCode: string;
  backupCodes: string[];
}

/**
 * Eight single-use codes in the xxxx-xxxx shape.
 *
 * Shared by setup and regeneration so both produce the same thing — two
 * copies of this would be two chances for one of them to drift to a weaker
 * RNG or a different length, and the weaker one would not look wrong.
 *
 * These bypass the authenticator entirely, so they come from the crypto RNG:
 * `Math.random()` is predictable, and an attacker who has seen one code could
 * work out the rest.
 */
const generateBackupCodes = (): string[] =>
  Array.from(
    { length: 8 },
    () =>
      crypto.randomInt(0, 10000).toString().padStart(4, "0") +
      "-" +
      crypto.randomInt(0, 10000).toString().padStart(4, "0"),
  );

/**
 * Generate a new TOTP secret and backup codes for 2FA setup
 */
export const generateTwoFactorSecret = async (
  email: string,
  appName: string = "Gym App",
): Promise<TwoFactorSetupResult> => {
  const secret = speakeasy.generateSecret({
    name: `${appName} (${email})`,
    issuer: appName,
    length: 32,
  });

  if (!secret.base32) {
    throw new Error("Failed to generate 2FA secret");
  }

  const qrCode = await QRCode.toDataURL(secret.otpauth_url || "");

  const backupCodes = generateBackupCodes();

  return {
    secret: secret.base32,
    qrCode,
    backupCodes,
  };
};

/**
 * Verify a TOTP code
 */
export const verifyTOTPCode = (secret: string, token: string): boolean => {
  return speakeasy.totp.verify({
    secret,
    encoding: "base32",
    token,
    window: 2, // Allow 30 seconds before/after for clock skew
  });
};

/**
 * Hash backup codes before storing in database
 */
export const hashBackupCode = async (code: string): Promise<string> => {
  return bcryptjs.hash(code, 10);
};

/**
 * Verify a backup code against stored hash
 */
export const verifyBackupCode = async (
  code: string,
  hash: string,
): Promise<boolean> => {
  return bcryptjs.compare(code, hash);
};

/**
 * Enable 2FA for a user (confirms the temporary setup)
 */
export const enableTwoFactor = async (
  userId: string,
  tempSecret: string,
  backupCodes: string[],
): Promise<void> => {
  // Hash backup codes
  const hashedCodes = await Promise.all(backupCodes.map(hashBackupCode));

  await prisma.user.update({
    where: { id: userId },
    data: {
      // Re-encrypted rather than moved across as stored: the temp secret is
      // handed to this function already decrypted by the caller that verified
      // the code against it, and writing that plaintext into the permanent
      // column is exactly the bug this is here to prevent.
      twoFactorSecret: encryptSecret(tempSecret, userId),
      twoFactorEnabled: true,
      twoFactorBackupCodes: JSON.stringify(hashedCodes),
      twoFactorTempSecret: null,
      twoFactorTempSecretAt: null,
    },
  });
};

/**
 * Issues a fresh set of backup codes, replacing whatever is left.
 *
 * Needed because the codes are single-use and shown once: an account that has
 * spent them has no way back in if the authenticator is ever lost, and the
 * only remedy before this was to disable 2FA and set it up again — which
 * means a window with the protection off, and a new QR to re-scan on every
 * device. Regenerating keeps the same secret, so nobody re-enrols.
 *
 * The old codes stop working the moment this returns. That is the point: a
 * code the user has written down and lost track of should not outlive the set
 * it belonged to.
 *
 * Returns the plaintext codes, which is the only time they exist outside the
 * user's hands — the column stores bcrypt hashes, exactly as `enableTwoFactor`
 * writes them.
 */
export const regenerateBackupCodes = async (
  userId: string,
): Promise<string[]> => {
  const codes = generateBackupCodes();
  const hashedCodes = await Promise.all(codes.map(hashBackupCode));

  await prisma.user.update({
    where: { id: userId },
    data: { twoFactorBackupCodes: JSON.stringify(hashedCodes) },
  });

  return codes;
};

/**
 * Disable 2FA for a user
 */
export const disableTwoFactor = async (userId: string): Promise<void> => {
  await prisma.user.update({
    where: { id: userId },
    data: {
      twoFactorSecret: null,
      twoFactorEnabled: false,
      twoFactorBackupCodes: null,
      twoFactorTempSecret: null,
      twoFactorTempSecretAt: null,
    },
  });
};

/**
 * Save temporary secret during 2FA setup (before verification)
 */
export const saveTempTwoFactorSecret = async (
  userId: string,
  tempSecret: string,
): Promise<void> => {
  await prisma.user.update({
    where: { id: userId },
    data: {
      twoFactorTempSecret: encryptSecret(tempSecret, userId),
      twoFactorTempSecretAt: new Date(),
    },
  });
};

/**
 * Reads a stored TOTP secret back into something `verifyTOTPCode` can use.
 *
 * Every read of `twoFactorSecret` or `twoFactorTempSecret` goes through here,
 * so no call site has to remember that the column is encrypted — forgetting
 * would mean comparing a code against ciphertext and locking the account out
 * with a message saying the code was wrong.
 *
 * Secrets written before encryption existed come back unchanged, so nobody is
 * locked out by the deploy that introduced it.
 */
export const readTwoFactorSecret = (stored: string, userId: string): string =>
  decryptSecret(stored, userId);

/**
 * Consume a backup code (remove it from the list after use)
 */
export const consumeBackupCode = async (
  userId: string,
  backupCode: string,
): Promise<boolean> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { twoFactorBackupCodes: true },
  });

  if (!user?.twoFactorBackupCodes) {
    return false;
  }

  const hashedCodes: string[] = JSON.parse(user.twoFactorBackupCodes);

  // Find and verify the backup code
  let codeIndex = -1;
  for (let i = 0; i < hashedCodes.length; i++) {
    if (await verifyBackupCode(backupCode, hashedCodes[i])) {
      codeIndex = i;
      break;
    }
  }

  if (codeIndex === -1) {
    return false;
  }

  // Remove used code
  hashedCodes.splice(codeIndex, 1);

  await prisma.user.update({
    where: { id: userId },
    data: {
      twoFactorBackupCodes: JSON.stringify(hashedCodes),
    },
  });

  return true;
};

/**
 * Marks a JWT as a login challenge rather than a session. The auth middleware
 * refuses any token carrying a purpose, so a challenge can never be replayed
 * as one — even though it is signed with the same secret.
 */
export const TWO_FACTOR_PURPOSE = "two-factor" as const;

/** How long the caller has to produce the second factor after the password. */
const CHALLENGE_TTL = "10m";

export interface TwoFactorChallenge {
  userId: string;
  tokenVersion: number;
}

/**
 * Signed after the password (or Google) check passes for an account that has
 * 2FA on. It proves only "the first factor was right" and buys the holder one
 * attempt at the second; the session cookie is issued only when that succeeds.
 *
 * The tokenVersion rides along so a password change during the challenge
 * strands it, exactly as it strands a session.
 */
export const signTwoFactorChallenge = (
  userId: string,
  tokenVersion: number,
): string =>
  jwt.sign(
    { userId, tokenVersion, purpose: TWO_FACTOR_PURPOSE },
    process.env.JWT_SECRET!,
    { expiresIn: CHALLENGE_TTL },
  );

/**
 * Reads a challenge back. Returns null for anything malformed, expired, or
 * not actually a challenge — the caller treats all of these the same way.
 */
export const verifyTwoFactorChallenge = (
  token: string,
): TwoFactorChallenge | null => {
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
    if (payload.purpose !== TWO_FACTOR_PURPOSE) return null;
    return { userId: payload.userId, tokenVersion: payload.tokenVersion };
  } catch {
    return null;
  }
};

/**
 * Get remaining backup code count
 */
export const getBackupCodeCount = async (userId: string): Promise<number> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { twoFactorBackupCodes: true },
  });

  if (!user?.twoFactorBackupCodes) {
    return 0;
  }

  try {
    const codes: string[] = JSON.parse(user.twoFactorBackupCodes);
    return codes.length;
  } catch {
    return 0;
  }
};
