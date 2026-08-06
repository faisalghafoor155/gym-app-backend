import type { Response } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../db.js';
import type { AuthedRequest } from '../types.js';
import type {
  CreateStaffBody, UpdateUserBody, CreateMemberLoginBody,
  TransferOwnershipBody, IdParam,
} from '../schemas.js';

const publicFields = {
  id: true, name: true, email: true, role: true,
  isActive: true, memberId: true, lastLoginAt: true, createdAt: true,
} as const;

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
        passwordHash: await bcrypt.hash(password, 10),
        role: 'staff',
      },
      select: publicFields,
    });
    res.status(201).json(user);
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
        passwordHash: await bcrypt.hash(password, 10),
        role: 'member',
      },
      select: publicFields,
    });
    res.status(201).json(user);
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

    const user = await prisma.user.update({
      where: { id },
      data: { ...(name && { name }), ...(isActive !== undefined && { isActive }) },
      select: publicFields,
    });
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

    await prisma.$transaction([
      prisma.user.update({ where: { id: target.id }, data: { role: 'owner' } }),
      prisma.user.update({ where: { id: req.userId }, data: { role: 'staff' } }),
      prisma.gym.update({ where: { id: req.gymId }, data: { ownerName: target.name } }),
    ]);

    res.json({ message: `Ownership transferred to ${target.name}. You are now staff.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
