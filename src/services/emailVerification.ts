import crypto from 'node:crypto';
import prisma from '../db.js';
import { sendMail, verifyEmailMail, mailEnabled } from './mail.js';
import { appUrl } from './invite.js';

/**
 * Proving that an address belongs to whoever is using the account.
 *
 * Public signup asks for an email and never checked it. The cost of that is
 * not fraud — somebody who registers a gym gets their own empty gym and none
 * of anybody else's — it is the typo. An owner who signs up as
 * `faisal@gmial.com` has no working password reset, no expiry reminders and no
 * receipts, and finds out at the moment they are already locked out.
 *
 * So nothing is withheld from an unverified account. The app says the address
 * is unconfirmed and offers to send the link again; that is the whole feature.
 * A gym that signed up this morning must be able to enrol its first member
 * this morning. It would also be a trap where no mail transport is configured
 * and the link goes to the container log — blocking there would mean nobody
 * can ever get in.
 *
 * Deliberately close to `invite.ts`: same hashing, same shape, same reasoning
 * about what a leaked database is worth. Two things that behave the same way
 * should look the same way.
 */

/** Long enough to survive an email that is read the next morning. */
export const VERIFY_TTL_HOURS = 24;
const VERIFY_TTL_MS = VERIFY_TTL_HOURS * 60 * 60 * 1000;

/** Only the hash is stored, so a database leak does not hand over live links. */
const hash = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');

export interface IssuedVerification {
  link: string;
  /** False when no transport is configured, so a caller can say so rather than
   *  leaving somebody waiting for mail that will never arrive. */
  emailed: boolean;
}

/**
 * Stamps a fresh verification token on an account and mails the link.
 *
 * Re-issuing overwrites the previous token, so "send it again" quietly
 * invalidates the earlier link — which is what somebody clicking it means.
 */
export const issueEmailVerification = async (
  userId: string,
  opts: { email: string; name: string; gymName: string },
): Promise<IssuedVerification> => {
  const token = crypto.randomBytes(32).toString('hex');

  await prisma.user.update({
    where: { id: userId },
    data: { verifyTokenHash: hash(token), verifyTokenAt: new Date() },
  });

  const link = `${appUrl()}/verify-email?token=${token}`;
  const emailed = await sendMail({
    to: opts.email,
    fromName: opts.gymName,
    ...verifyEmailMail(link, VERIFY_TTL_HOURS, opts.gymName, opts.name),
  });

  return { link, emailed };
};

/**
 * Marks an address verified, given a raw token.
 *
 * Returns false for a token that is unknown, expired, or already spent — all
 * three answered the same way, since telling them apart would only help
 * somebody guessing.
 *
 * Clearing the hash in the same update is what makes the link single-use: a
 * second click finds no matching row.
 */
export const consumeEmailVerification = async (token: string): Promise<boolean> => {
  const user = await prisma.user.findFirst({
    where: { verifyTokenHash: hash(token) },
    select: { id: true, verifyTokenAt: true, isActive: true },
  });

  if (!user?.verifyTokenAt || !user.isActive) return false;
  if (Date.now() - user.verifyTokenAt.getTime() > VERIFY_TTL_MS) return false;

  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerifiedAt: new Date(),
      verifyTokenHash: null,
      verifyTokenAt: null,
    },
  });

  return true;
};

export { mailEnabled };
