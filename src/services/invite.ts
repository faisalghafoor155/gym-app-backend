import crypto from 'node:crypto';
import prisma from '../db.js';
import { sendMail, inviteMail, mailEnabled } from './mail.js';
import { reachableUrl } from './lanAddress.js';

/**
 * Inviting somebody instead of choosing a password for them.
 *
 * The account is created with a null passwordHash, which cannot sign in — not
 * with a blank password, not with any password — so an invite that is never
 * accepted leaves behind a row that is inert rather than a weak login.
 */

/** Longer than a password reset: an invite often arrives while somebody is at
 *  work, and re-inviting is a manual step for the owner. */
export const INVITE_TTL_HOURS = 48;
const INVITE_TTL_MS = INVITE_TTL_HOURS * 60 * 60 * 1000;

/** Where emailed links point. A `localhost` APP_URL is swapped for this PC's
 *  LAN address, since the link is usually opened on a phone. */
export const appUrl = (): string =>
  reachableUrl(process.env.APP_URL ?? 'http://localhost:8080');

/** Only the hash is stored, so a database leak does not hand over live links. */
const hash = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');

export interface IssuedInvite {
  link: string;
  /** False when no transport is configured, so the caller can tell the owner
   *  to pass the link on by hand rather than leaving them waiting. */
  emailed: boolean;
}

/**
 * Stamps a fresh invite on an existing account and mails the link.
 *
 * Re-issuing overwrites the previous token, so a second invite quietly
 * invalidates the first — which is what an owner clicking "resend" means.
 */
export const issueInvite = async (
  userId: string,
  opts: { email: string; gymName: string; role: 'staff' | 'member'; invitedBy: string },
): Promise<IssuedInvite> => {
  const token = crypto.randomBytes(32).toString('hex');

  await prisma.user.update({
    where: { id: userId },
    data: { inviteTokenHash: hash(token), inviteTokenAt: new Date() },
  });

  const link = `${appUrl()}/accept-invite?token=${token}`;
  const emailed = await sendMail({
    to: opts.email,
    fromName: opts.gymName,
    ...inviteMail(link, INVITE_TTL_HOURS, opts.gymName, opts.role, opts.invitedBy),
  });

  return { link, emailed };
};

export interface InviteLookup {
  userId: string;
  gymId: string;
}

/**
 * Resolves a raw invite token to the account it belongs to, or null when it is
 * unknown, expired, or already spent.
 *
 * The token is looked up by hash, so a stolen database gives an attacker
 * nothing they can present here.
 */
export const findValidInvite = async (token: string): Promise<InviteLookup | null> => {
  const user = await prisma.user.findFirst({
    where: { inviteTokenHash: hash(token) },
    select: { id: true, gymId: true, inviteTokenAt: true, isActive: true },
  });

  if (!user?.inviteTokenAt || !user.isActive) return null;
  if (Date.now() - user.inviteTokenAt.getTime() > INVITE_TTL_MS) return null;

  return { userId: user.id, gymId: user.gymId };
};

/** Whether mail is configured, so callers can shape their response around it
 *  rather than promising an email nobody will receive. */
export { mailEnabled };
