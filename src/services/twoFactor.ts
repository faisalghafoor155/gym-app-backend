/** @format */

import crypto from "node:crypto";
import speakeasy from "speakeasy";
import QRCode from "qrcode";
import bcryptjs from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../db.js";
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

  // Generate 8 backup codes (4 digit pairs). These are single-use
  // credentials that bypass the authenticator, so they must come from a
  // cryptographic RNG — Math.random() is predictable and would let an
  // attacker who has seen one code guess the rest.
  const backupCodes = Array.from(
    { length: 8 },
    () =>
      crypto.randomInt(0, 10000).toString().padStart(4, "0") +
      "-" +
      crypto.randomInt(0, 10000).toString().padStart(4, "0"),
  );

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
      twoFactorSecret: tempSecret,
      twoFactorEnabled: true,
      twoFactorBackupCodes: JSON.stringify(hashedCodes),
      twoFactorTempSecret: null,
      twoFactorTempSecretAt: null,
    },
  });
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
      twoFactorTempSecret: tempSecret,
      twoFactorTempSecretAt: new Date(),
    },
  });
};

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
