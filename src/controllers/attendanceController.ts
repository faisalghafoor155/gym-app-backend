import type { Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../db.js';
import { currentMembershipWhere, toView, withPlan } from '../services/membership.js';
import { getPhotoUrl } from '../services/s3.js';
import type { AuthedRequest } from '../types.js';
import type { CheckinBody, IdParam, SelfCheckinBody } from '../schemas.js';
import {
  GYM_CHECKIN_ROTATE_SECONDS, signGymCheckinToken, verifyGymCheckinToken,
} from '../services/gymCheckin.js';

// `memberNo` travels with the rest because the desk reads it out to confirm
// who is standing there — a name alone is ambiguous in a gym with two Ahmeds.
//
// `photoKey` comes too so the face can be signed on the way out: the bucket is
// private, and `photo` alone is only populated for members whose picture
// predates S3.
const memberSummary = {
  member: {
    select: {
      name: true,
      phone: true,
      photo: true,
      photoKey: true,
      memberNo: true,
    },
  },
} as const;

/** A member summary with its face turned into a short-lived signed URL. */
type WithMember = { member: { photo: string | null; photoKey: string | null } };

const signMember = async <T extends WithMember>(row: T): Promise<T> => ({
  ...row,
  member: {
    ...row.member,
    // A legacy inline base64 photo is already a usable src; only a key needs
    // signing. Either way the client reads one field, `photo`.
    photo: row.member.photo ?? (await getPhotoUrl(row.member.photoKey)),
  },
});

const signMembers = async <T extends WithMember>(rows: T[]): Promise<T[]> =>
  Promise.all(rows.map(signMember));

/** The window a check-in belongs to: midnight to midnight, local time. */
const dayBounds = (now: Date): { start: Date; end: Date } => {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

/**
 * What the current membership cost and how much of it has been paid.
 *
 * Counted the same way the dues list counts it: only settled payments linked
 * to this membership, and a balance that never goes negative — overpaying is
 * not a debt.
 */
const feeSummary = (
  view: { pricePaid: number } | null,
  payments: { amount: Prisma.Decimal }[],
): { amount: number; paid: number; balance: number } | null => {
  if (!view) return null;
  const paid = payments.reduce((t, p) => t + p.amount.toNumber(), 0);
  return {
    amount: view.pricePaid,
    paid,
    balance: Math.max(0, view.pricePaid - paid),
  };
};

/**
 * Records that a member turned up.
 *
 * Two things this deliberately does *not* do:
 *
 * It does not record a second visit on the same day. Attendance is the count
 * the gym reasons about — how busy an evening was, who has stopped coming — and
 * a member clicked twice is indistinguishable from one who came twice once the
 * rows are in. The page already greys out anyone checked in, but that guard
 * reads a list fetched seconds ago: two receptionists, or one stale tab, walks
 * straight past it. The second attempt answers 200 with the original row rather
 * than an error, because the desk's intent — "this person is here" — is already
 * satisfied, and a red toast for a duplicate press trains staff to ignore red.
 *
 * It does not turn anyone away for an expired membership. Nothing else in the
 * app does either: the dashboard files expired members under people to phone,
 * not people to lock out, and somebody standing at the desk with cash in hand is
 * exactly who the gym wants inside. The membership travels back with the
 * response instead, so the front desk sees "expired 12 days ago" at the moment
 * it can still do something about it.
 */
export const checkin = async (
  req: AuthedRequest<Record<string, string>, unknown, CheckinBody>,
  res: Response,
): Promise<void> => {
  try {
    await recordCheckin(req.gymId, req.body.memberId, res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * A member checking themselves in by scanning the gym's QR with their phone.
 *
 * The QR token proves the phone was pointed at this gym's screen in the last
 * couple of minutes; the session proves who is holding the phone. Both are
 * needed — the token alone names nobody, and a session alone would let anyone
 * check in from home.
 *
 * Everything after that is the desk's own check-in, so the rules match: one
 * row a day, an expired membership let through with the details attached.
 */
export const selfCheckin = async (
  req: AuthedRequest<Record<string, string>, unknown, SelfCheckinBody>,
  res: Response,
): Promise<void> => {
  const gymId = verifyGymCheckinToken(req.body.token);
  if (!gymId) {
    res.status(400).json({
      error: 'This QR code has expired. Scan the code on the gym screen again.',
      reason: 'expired',
    });
    return;
  }
  if (gymId !== req.gymId) {
    res.status(403).json({ error: 'This QR code belongs to a different gym.', reason: 'wrong_gym' });
    return;
  }
  if (!req.memberId) {
    res.status(404).json({
      error: 'This account is not linked to a member, so it cannot check in. Sign in with a member account.',
      reason: 'not_member',
    });
    return;
  }
  try {
    await recordCheckin(req.gymId, req.memberId, res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * A fresh token for the gym QR on the desk screen.
 *
 * `appUrl` is what the server was told its public address is. The desktop app
 * sets it to the PC's Wi-Fi address, which is the one a phone can actually
 * open — the desk itself is often looking at `localhost`, which on a phone
 * means the phone.
 */
export const getGymQr = (req: AuthedRequest, res: Response): void => {
  res.json({
    token: signGymCheckinToken(req.gymId),
    rotateSeconds: GYM_CHECKIN_ROTATE_SECONDS,
    appUrl: process.env.APP_URL?.replace(/\/+$/, '') || null,
  });
};

/** The check-in itself, shared by the desk and the member's own phone. */
const recordCheckin = async (gymId: string, memberId: string, res: Response): Promise<void> => {
  const member = await prisma.member.findFirst({
    where: { id: memberId, gymId },
    select: {
      id: true,
      memberships: {
        where: currentMembershipWhere,
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: {
          ...withPlan,
          // Settled money only; a row still marked due is the debt itself.
          payments: { where: { status: 'paid' }, select: { amount: true } },
        },
      },
    },
  });
  if (!member) {
    res.status(404).json({ error: 'Member not found' });
    return;
  }

  const now = new Date();
  const { start, end } = dayBounds(now);
  const current = member.memberships[0] ?? null;
  // What the desk needs to know before waving somebody through, and the same
  // shape the members list already speaks.
  const membership = current ? toView(current, now) : null;
  const fee = feeSummary(membership, current?.payments ?? []);

  const existing = await prisma.attendance.findFirst({
    where: { memberId, gymId, checkedInAt: { gte: start, lte: end } },
    include: memberSummary,
  });
  if (existing) {
    // 200 rather than 201: nothing was created. `alreadyCheckedIn` is what
    // lets the page say so instead of claiming a fresh arrival.
    res.json({ ...(await signMember(existing)), membership, fee, alreadyCheckedIn: true });
    return;
  }

  try {
    const record = await prisma.attendance.create({
      data: { memberId, gymId: gymId },
      include: memberSummary,
    });
    res.status(201).json({
      ...(await signMember(record)),
      membership,
      fee,
      alreadyCheckedIn: false,
    });
  } catch (err) {
    // The other half of the race the constraint exists for: both requests
    // passed the check above, and this one lost the insert. The member is
    // checked in either way, which is what the caller asked for — so answer
    // as though this request had been the one to find the existing row,
    // rather than reporting a failure for something that succeeded.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.attendance.findFirst({
        where: { memberId, gymId, checkedInAt: { gte: start, lte: end } },
        include: memberSummary,
      });
      if (winner) {
        res.json({ ...(await signMember(winner)), membership, fee, alreadyCheckedIn: true });
        return;
      }
    }
    throw err;
  }
};

export const getToday = async (req: AuthedRequest, res: Response): Promise<void> => {
  try {
    // The same bounds the check-in uses to decide what "already today" means,
    // so the list and the guard can never disagree about where the day ends.
    const { start, end } = dayBounds(new Date());

    const records = await prisma.attendance.findMany({
      where: { gymId: req.gymId, checkedInAt: { gte: start, lte: end } },
      include: memberSummary,
      orderBy: { checkedInAt: 'desc' },
    });
    res.json(await signMembers(records));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const getMemberHistory = async (
  req: AuthedRequest<IdParam>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  try {
    const records = await prisma.attendance.findMany({
      where: { memberId: id, gymId: req.gymId },
      orderBy: { checkedInAt: 'desc' },
      take: 30,
    });
    res.json(records);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
