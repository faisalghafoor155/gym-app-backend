import type { Response } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../db.js';
import { setSessionCookie } from '../services/session.js';
import { audit, diff } from '../services/audit.js';
import type { AuthedRequest } from '../types.js';
import { issueInvite } from '../services/invite.js';
import type {
  CreateStaffBody, UpdateUserBody, CreateMemberLoginBody,
  TransferOwnershipBody, IdParam,
} from '../schemas.js';

const publicFields = {
  id: true, name: true, email: true, role: true,
  isActive: true, memberId: true, lastLoginAt: true, createdAt: true,
} as const;

const gymName = async (gymId: string): Promise<string> => {
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
    select: { name: true },
  });
  return gym?.name ?? 'your gym';
};

/**
 * What the client is told about an invite.
 *
 * The link comes back only when no mail was sent — the owner then has to pass
 * it on themselves, and hiding it would strand the account. When mail did go
 * out the link stays server-side, so it cannot be read off a screen by whoever
 * is standing at the front desk.
 */
const inviteInfo = (invite: { link: string; emailed: boolean } | null) => {
  if (!invite) return null;
  return invite.emailed
    ? { emailed: true as const }
    : { emailed: false as const, link: invite.link };
};

/** Everyone who can sign in to this gym. */
export const getAll = async (req: AuthedRequest, res: Response): Promise<void> => {
  try {
    const users = await prisma.user.findMany({
      where: { gymId: req.gymId },
      select: { ...publicFields, member: { select: { id: true, name: true } } },
      orderBy: [{ role: 'asc' }, { createdAt: 'desc' }],
    });
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/** Owner-only: add a helper/employee who can run the gym day to day. */
export const createStaff = async (
  req: AuthedRequest<Record<string, string>, unknown, CreateStaffBody>,
  res: Response,
): Promise<void> => {
  const { name, email, password } = req.body;
  try {
    if (await prisma.user.findUnique({ where: { email } })) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }

    const user = await prisma.user.create({
      data: {
        gymId: req.gymId, name, email,
        // Null without a password: the account exists but cannot sign in until
        // the invite is accepted.
        passwordHash: password ? await bcrypt.hash(password, 10) : null,
        role: 'staff',
      },
      select: publicFields,
    });

    const invite = password
      ? null
      : await issueInvite(user.id, {
          email, gymName: await gymName(req.gymId),
          role: 'staff', invitedBy: req.actorName,
        });

    await audit(req, {
      action: 'staff.create',
      entity: 'user',
      entityId: user.id,
      entityLabel: `${user.name} · staff`,
      // Which way the account was created is the part worth being able to look
      // up later; the password itself never goes near an audit row.
      after: { name, email, role: 'staff', method: password ? 'password' : 'invite' },
    });

    res.status(201).json({ ...user, invite: inviteInfo(invite) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Gives an existing member a login. Members never sign themselves up — the
 * gym decides who gets access to its data.
 */
export const createMemberLogin = async (
  req: AuthedRequest<Record<string, string>, unknown, CreateMemberLoginBody>,
  res: Response,
): Promise<void> => {
  const { memberId, email, password } = req.body;
  try {
    const member = await prisma.member.findFirst({
      where: { id: memberId, gymId: req.gymId },
      include: { user: { select: { id: true } } },
    });
    if (!member) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    if (member.user) {
      res.status(409).json({ error: 'This member already has a login' });
      return;
    }
    if (await prisma.user.findUnique({ where: { email } })) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }

    const user = await prisma.user.create({
      data: {
        gymId: req.gymId, memberId, email,
        name: member.name,
        passwordHash: password ? await bcrypt.hash(password, 10) : null,
        role: 'member',
      },
      select: publicFields,
    });

    const invite = password
      ? null
      : await issueInvite(user.id, {
          email, gymName: await gymName(req.gymId),
          role: 'member', invitedBy: req.actorName,
        });

    await audit(req, {
      action: 'memberLogin.create',
      entity: 'user',
      entityId: user.id,
      entityLabel: `${member.memberNo} · ${member.name}`,
      after: { memberId, email, role: 'member', method: password ? 'password' : 'invite' },
    });

    res.status(201).json({ ...user, invite: inviteInfo(invite) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/** Owner-only: deactivate/reactivate an account or rename it. */
export const update = async (
  req: AuthedRequest<IdParam, unknown, UpdateUserBody>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  const { name, isActive } = req.body;
  try {
    const target = await prisma.user.findFirst({ where: { id, gymId: req.gymId } });
    if (!target) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    // Locking the last owner out would leave the gym unmanageable.
    if (target.role === 'owner' && isActive === false) {
      res.status(400).json({ error: 'The owner account cannot be deactivated' });
      return;
    }

    // Deactivating has to reach the sessions that account already has open.
    // `auth` would catch it on the next request anyway via `isActive`, but
    // bumping the version keeps one rule — a revoked token is a stale token —
    // rather than two ways for a session to die. Reactivating leaves the
    // version alone; there is nothing live to strand.
    const revoke = isActive === false;

    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(isActive !== undefined && { isActive }),
        ...(revoke && { tokenVersion: { increment: 1 } }),
      },
      select: publicFields,
    });

    const changed = diff(target, user, ['name', 'isActive'] as const);
    if (changed) {
      await audit(req, {
        action: 'staff.update',
        entity: 'user',
        entityId: id,
        entityLabel: `${user.name} · ${user.role}`,
        ...changed,
      });
    }

    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const remove = async (
  req: AuthedRequest<IdParam>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  try {
    const target = await prisma.user.findFirst({ where: { id, gymId: req.gymId } });
    if (!target) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    if (target.role === 'owner') {
      res.status(400).json({ error: 'The owner account cannot be deleted. Transfer ownership first.' });
      return;
    }

    await prisma.user.delete({ where: { id } });

    await audit(req, {
      action: 'staff.delete',
      entity: 'user',
      entityId: id,
      entityLabel: `${target.name} · ${target.role}`,
      before: { name: target.name, email: target.email, role: target.role },
    });

    res.json({ message: 'Account removed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Hands the gym to another account. Done in one transaction so the gym is
 * never left with two owners or none.
 */
export const transferOwnership = async (
  req: AuthedRequest<Record<string, string>, unknown, TransferOwnershipBody>,
  res: Response,
): Promise<void> => {
  const { userId } = req.body;
  try {
    const target = await prisma.user.findFirst({ where: { id: userId, gymId: req.gymId } });
    if (!target) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    if (target.id === req.userId) {
      res.status(400).json({ error: 'You already own this gym' });
      return;
    }
    if (!target.isActive) {
      res.status(400).json({ error: 'That account is deactivated' });
      return;
    }

    // Both accounts change role, so both sets of open sessions have to go —
    // otherwise the outgoing owner keeps owner access on any other device
    // until their token happens to expire.
    const [, self] = await prisma.$transaction([
      prisma.user.update({
        where: { id: target.id },
        data: { role: 'owner', tokenVersion: { increment: 1 } },
      }),
      prisma.user.update({
        where: { id: req.userId },
        data: { role: 'staff', tokenVersion: { increment: 1 } },
        select: { tokenVersion: true },
      }),
      prisma.gym.update({ where: { id: req.gymId }, data: { ownerName: target.name } }),
    ]);

    // The browser that performed the transfer stays signed in — now as staff —
    // instead of being bounced to the login page by its own action.
    setSessionCookie(res, req.userId, self.tokenVersion);

    await audit(req, {
      action: 'ownership.transfer',
      entity: 'gym',
      entityId: req.gymId,
      entityLabel: target.name,
      before: { ownerId: req.userId, ownerName: req.actorName },
      after: { ownerId: target.id, ownerName: target.name },
    });

    res.json({ message: `Ownership transferred to ${target.name}. You are now staff.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
