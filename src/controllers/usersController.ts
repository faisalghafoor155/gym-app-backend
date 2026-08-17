import type { Response } from 'express';
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';
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
  staffPermission: true,
} as const;

/**
 * How many staff accounts one gym may have.
 *
 * Counts deactivated accounts too. A revoked account still holds its email
 * address — the unique constraint means nobody else can be invited on it — and
 * can be restored in one click, so it is a seat that is taken. Freeing it is
 * what deleting the account is for, and the error says so.
 *
 * The owner is not counted: they are the gym, not one of its helpers.
 */
export const STAFF_SEATS = 6;

/** Staff seats used and left, for the client to render before it asks. */
const seatUsage = async (gymId: string) => {
  const used = await prisma.user.count({ where: { gymId, role: 'staff' } });
  return { limit: STAFF_SEATS, used, remaining: Math.max(0, STAFF_SEATS - used) };
};

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

/** Everyone who can sign in to this gym, and how many staff seats are left. */
export const getAll = async (req: AuthedRequest, res: Response): Promise<void> => {
  try {
    const [users, seats] = await Promise.all([
      prisma.user.findMany({
        where: { gymId: req.gymId },
        select: { ...publicFields, member: { select: { id: true, name: true } } },
        orderBy: [{ role: 'asc' }, { createdAt: 'desc' }],
      }),
      seatUsage(req.gymId),
    ]);
    // Seats travel with the list so the page can say "2 left" before the owner
    // fills in a form that would be refused. The server still refuses it —
    // this is the courtesy, not the rule.
    res.json({ users, seats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/** Raised when the gym has no staff seat left, so the transaction rolls back
 *  rather than creating a seventh account. */
class SeatsFullError extends Error {}

/**
 * Takes the gym's seat lock, then refuses if it is full.
 *
 * The lock is the whole point. Counting inside a transaction is *not* enough on
 * its own: under Postgres' default READ COMMITTED, two concurrent invites each
 * run their own `count`, neither sees the other's uncommitted row, both read
 * five seats used, and both commit — which is exactly what a race test does to
 * an unlocked version of this.
 *
 * `SELECT ... FOR UPDATE` on the Gym row makes the second caller wait for the
 * first to commit before it counts, so the count it reads is the one it acts
 * on. Locking the gym rather than the user rows is deliberate: the rows being
 * counted do not exist yet, so there is nothing else to take a lock on.
 *
 * Contention is per-gym and held for one insert, so this costs nothing in
 * practice — two owners at different gyms never wait on each other.
 */
const claimStaffSeat = async (tx: Prisma.TransactionClient, gymId: string): Promise<void> => {
  await tx.$queryRaw`SELECT id FROM "Gym" WHERE id = ${gymId} FOR UPDATE`;
  const used = await tx.user.count({ where: { gymId, role: 'staff' } });
  if (used >= STAFF_SEATS) throw new SeatsFullError();
};

/** Owner-only: add a helper/employee who can run the gym day to day. */
export const createStaff = async (
  req: AuthedRequest<Record<string, string>, unknown, CreateStaffBody>,
  res: Response,
): Promise<void> => {
  const { name, email, password, staffPermission } = req.body;
  try {
    if (await prisma.user.findUnique({ where: { email } })) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }

    // Hashing is deliberately outside the transaction: bcrypt takes ~100ms and
    // holding a transaction open for it would serialise every other write to
    // this gym behind a CPU-bound loop.
    const passwordHash = password ? await bcrypt.hash(password, 10) : null;

    const user = await prisma.$transaction(async tx => {
      await claimStaffSeat(tx, req.gymId);

      return tx.user.create({
        data: {
          gymId: req.gymId, name, email,
          // Null without a password: the account exists but cannot sign in
          // until the invite is accepted.
          passwordHash,
          role: 'staff',
          staffPermission: staffPermission || 'receptionist',
        },
        select: publicFields,
      });
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

    res.status(201).json({
      ...user,
      invite: inviteInfo(invite),
      seats: await seatUsage(req.gymId),
    });
  } catch (err) {
    if (err instanceof SeatsFullError) {
      res.status(409).json({
        error: `This gym can have ${STAFF_SEATS} staff accounts, and all ${STAFF_SEATS} are in use. Remove one to free a seat — revoked accounts still hold theirs.`,
      });
      return;
    }
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

/** Owner-only: rename an account, change what it may do, or switch it off. */
export const update = async (
  req: AuthedRequest<IdParam, unknown, UpdateUserBody>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  const { name, isActive, role, staffPermission } = req.body;
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
    // Demoting the owner here would leave the gym with nobody who can manage
    // it — and unlike transfer-ownership there is no replacement in the same
    // breath. The schema already refuses to promote anyone *to* owner, so this
    // is the other half of the same rule.
    if (target.role === 'owner' && role) {
      res.status(400).json({
        error: 'The owner cannot be demoted. Transfer ownership instead.',
      });
      return;
    }
    // A member login is the account attached to a Member record, and that link
    // is what `/my` reads. Promoting it to staff would leave a staff account
    // still wired to one member's data; dropping the link instead would strand
    // the member. Neither is a change the owner can have meant.
    if (role && role !== target.role && target.memberId) {
      res.status(400).json({
        error: 'A member login cannot change role. Remove it and invite a staff account instead.',
      });
      return;
    }

    // Both of these have to reach the sessions that account already has open.
    //
    // Deactivating: `auth` would catch it next request anyway via `isActive`,
    // but bumping the version keeps one rule — a revoked token is a stale token
    // — rather than two ways for a session to die.
    //
    // A role change: `auth` re-reads the role from the database on every
    // request, so a demoted staff member loses access immediately either way.
    // The bump is what closes the gap for a *promotion* going the other way,
    // and keeps the rule uniform rather than "sometimes we re-issue".
    // Reactivating alone leaves the version alone; there is nothing to strand.
    const revoke = isActive === false || (role !== undefined && role !== target.role);

    // Promoting somebody to staff takes a seat, exactly as creating one does,
    // so it is counted and applied in one transaction for the same reason.
    const promoting = role === 'staff' && target.role !== 'staff';

    // If the role is changed to member, clear staff permissions.
    // If promoting to staff and no permission is specified, default to receptionist.
    let updatedStaffPermission = staffPermission !== undefined ? staffPermission : undefined;
    if (role === 'member') {
      updatedStaffPermission = null;
    } else if (promoting && !staffPermission) {
      updatedStaffPermission = 'receptionist';
    }

    const user = await prisma.$transaction(async tx => {
      if (promoting) await claimStaffSeat(tx, req.gymId);
      return tx.user.update({
        where: { id },
        data: {
          ...(name && { name }),
          ...(isActive !== undefined && { isActive }),
          ...(role && { role }),
          ...(updatedStaffPermission !== undefined && { staffPermission: updatedStaffPermission }),
          ...(revoke && { tokenVersion: { increment: 1 } }),
        },
        select: publicFields,
      });
    });

    const changed = diff(target, user, ['name', 'isActive', 'role', 'staffPermission'] as const);
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
    if (err instanceof SeatsFullError) {
      res.status(409).json({
        error: `This gym can have ${STAFF_SEATS} staff accounts, and all ${STAFF_SEATS} are in use. Remove one to free a seat — revoked accounts still hold theirs.`,
      });
      return;
    }
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
