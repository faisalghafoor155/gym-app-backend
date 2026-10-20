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
export const verifyTOTPCode = (secret: string, token: string): boolean =>
  matchTotpStep(secret, token) !== null;

/** Length of one TOTP time-step, in seconds. */
const TOTP_STEP_SECONDS = 30;

/**
 * The time-step a code belongs to, or null if it is not valid right now.
 *
 * One step either side is allowed for clock skew (about 90 seconds of
 * validity in all, down from the 150 a window of two gave). Returning the step
 * rather than a boolean is what lets a login refuse a code that was already
 * spent: see `consumeTotpStep`.
 */
export const matchTotpStep = (secret: string, token: string): number | null => {
  const result = speakeasy.totp.verifyDelta({
    secret,
    encoding: "base32",
    token,
    window: 1,
    step: TOTP_STEP_SECONDS,
  });
  if (!result) return null;
  return Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS) + result.delta;
};

/**
 * Marks a time-step as spent. Returns false if that step, or a later one, was
 * already accepted — so a code that has been used once, by the owner or by
 * someone who watched it being typed, cannot be used again inside its window.
 *
 * One conditional UPDATE rather than read-then-write: two simultaneous
 * requests carrying the same code race on the row, and exactly one of them
 * sees a count of 1.
 */
export const consumeTotpStep = async (
  userId: string,
  step: number,
): Promise<boolean> => {
  const { count } = await prisma.user.updateMany({
    where: {
      id: userId,
      OR: [{ twoFactorLastStep: null }, { twoFactorLastStep: { lt: step } }],
    },
    data: { twoFactorLastStep: step },
  });
  return count === 1;
};

/** Wrong second-factor attempts allowed before the account is locked. */
export const LOCKOUT_THRESHOLD = 5;
/** How long the lock lasts. */
export const LOCKOUT_MS = 15 * 60 * 1000;

export const isTwoFactorLocked = (lockedUntil: Date | null): boolean =>
  lockedUntil !== null && lockedUntil.getTime() > Date.now();

/**
 * Counts a wrong second-factor attempt against the account, not the caller's
 * IP: the IP limiter alone costs an attacker nothing but a new address. At the
 * threshold the account locks and the counter resets, so the next window
 * starts clean.
 */
export const recordFailedTwoFactorAttempt = async (
  userId: string,
): Promise<void> => {
  const { twoFactorFailedAttempts } = await prisma.user.update({
    where: { id: userId },
    data: { twoFactorFailedAttempts: { increment: 1 } },
    select: { twoFactorFailedAttempts: true },
  });
  if (twoFactorFailedAttempts >= LOCKOUT_THRESHOLD) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorFailedAttempts: 0,
        twoFactorLockedUntil: new Date(Date.now() + LOCKOUT_MS),
      },
    });
  }
};

export const clearTwoFactorAttempts = async (userId: string): Promise<void> => {
  await prisma.user.update({
    where: { id: userId },
    data: { twoFactorFailedAttempts: 0, twoFactorLockedUntil: null },
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
  hashedBackupCodes: string,
): Promise<void> => {
  await prisma.user.update({
    where: { id: userId },
    data: {
      // Re-encrypted rather than moved across as stored: the temp secret is
      // handed to this function already decrypted by the caller that verified
      // the code against it, and writing that plaintext into the permanent
      // column is exactly the bug this is here to prevent.
      twoFactorSecret: encryptSecret(tempSecret, userId),
      twoFactorEnabled: true,
      twoFactorBackupCodes: hashedBackupCodes,
      twoFactorTempSecret: null,
      twoFactorTempSecretAt: null,
      twoFactorTempBackupCodes: null,
      twoFactorFailedAttempts: 0,
      twoFactorLockedUntil: null,
      twoFactorLastStep: null,
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
      twoFactorTempBackupCodes: null,
      twoFactorFailedAttempts: 0,
      twoFactorLockedUntil: null,
      twoFactorLastStep: null,
    },
  });
};

/**
 * Save temporary secret during 2FA setup (before verification)
 */
export const saveTempTwoFactorSecret = async (
  userId: string,
  tempSecret: string,
  backupCodes: string[],
): Promise<void> => {
  // The server keeps the hashes. The client is shown the plaintext once and
  // sends back only the TOTP code, so it cannot pick which codes get stored.
  const hashed = await Promise.all(backupCodes.map(hashBackupCode));
  await prisma.user.update({
    where: { id: userId },
    data: {
      twoFactorTempSecret: encryptSecret(tempSecret, userId),
      twoFactorTempSecretAt: new Date(),
      twoFactorTempBackupCodes: JSON.stringify(hashed),
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

  const stored = user.twoFactorBackupCodes;
  const hashedCodes: string[] = JSON.parse(stored);

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

  // Compare-and-swap on the exact list that was read. Two simultaneous
  // requests with the same code both pass the bcrypt check above; only the
  // first finds the column unchanged, and the second matches no row.
  const { count } = await prisma.user.updateMany({
    where: { id: userId, twoFactorBackupCodes: stored },
    data: { twoFactorBackupCodes: JSON.stringify(hashedCodes) },
  });

  return count === 1;
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
