import type { Response } from 'express';
import prisma from '../db.js';
import { audit } from '../services/audit.js';
import type { AuthedRequest } from '../types.js';
import type {
  CreateTrainerBody, UpdateTrainerBody, TrainerQuery, IdParam,
} from '../schemas.js';

/**
 * The gym's trainers, a page at a time.
 *
 * `all=true` is the escape hatch the pickers use — the members page, the
 * classes page and the PT form each render a trainer dropdown, and one that
 * stopped at the first page would silently make later trainers unassignable.
 */
export const getAll = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, TrainerQuery>,
  res: Response,
): Promise<void> => {
  const { search, includeInactive, page, limit, all } = req.query;
  try {
    const where = {
      gymId: req.gymId,
      // Retired trainers are kept because sessions they took still have to
      // resolve, but they are off the default list rather than mixed in with
      // the people currently on the floor.
      ...(includeInactive ? {} : { isActive: true }),
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' as const } },
          { phone: { contains: search, mode: 'insensitive' as const } },
          { specialization: { contains: search, mode: 'insensitive' as const } },
        ],
      }),
    };

    const [trainers, total] = await Promise.all([
      prisma.trainer.findMany({
        where,
        include: {
          _count: {
            select: { members: { where: { status: 'active' } } },
          },
        },
        orderBy: { name: 'asc' },
        // The dropdowns on the members, classes and PT pages all ask for
        // everything: a trainer missing from a picker cannot be assigned.
        ...(all ? {} : { skip: (page - 1) * limit, take: limit }),
      }),
      prisma.trainer.count({ where }),
    ]);

    const result = trainers.map(t => ({
      id: t.id,
      name: t.name,
      phone: t.phone,
      specialization: t.specialization,
      commissionPercentage: Number(t.commissionPercentage),
      // Null travels as null rather than as the gym default: the UI has to be
      // able to show "uses the gym default" as distinct from a price that
      // happens to equal it.
      ptFee: t.ptFee === null ? null : Number(t.ptFee),
      isActive: t.isActive,
      createdAt: t.createdAt,
      activeMembersCount: t._count.members,
    }));

    res.json({
      data: result,
      total,
      page: all ? 1 : page,
      limit: all ? result.length : limit,
      hasMore: all ? false : page * limit < total,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Creates a new trainer profile.
 */
export const create = async (
  req: AuthedRequest<unknown, unknown, CreateTrainerBody>,
  res: Response,
): Promise<void> => {
  const { name, phone, specialization, commissionPercentage, ptFee } = req.body;
  try {
    const trainer = await prisma.trainer.create({
      data: {
        gymId: req.gymId,
        name,
        phone,
        specialization,
        commissionPercentage,
        ptFee: ptFee ?? null,
      },
    });

    await audit(req, {
      action: 'trainer.create',
      entity: 'trainer',
      entityId: trainer.id,
      entityLabel: trainer.name,
      after: {
        name,
        phone,
        specialization,
        commissionPercentage,
        ptFee: ptFee ?? null,
      },
    });

    res.status(201).json({
      ...trainer,
      commissionPercentage: Number(trainer.commissionPercentage),
      ptFee: trainer.ptFee === null ? null : Number(trainer.ptFee),
      activeMembersCount: 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Updates an existing trainer's details.
 */
export const update = async (
  req: AuthedRequest<IdParam, unknown, UpdateTrainerBody>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  const { name, phone, specialization, commissionPercentage, ptFee } = req.body;
  try {
    const trainer = await prisma.trainer.findFirst({
      where: { id, gymId: req.gymId },
    });
    if (!trainer) {
      res.status(404).json({ error: 'Trainer not found' });
      return;
    }

    const updated = await prisma.trainer.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(phone !== undefined && { phone }),
        ...(specialization !== undefined && { specialization }),
        ...(commissionPercentage !== undefined && { commissionPercentage }),
        // `null` is a meaningful value here — it hands the trainer back to the
        // gym default — so it is written through, unlike the fields above
        // where only `undefined` means "leave alone".
        ...(ptFee !== undefined && { ptFee }),
      },
    });

    const feeOf = (v: typeof trainer.ptFee) => (v === null ? null : Number(v));

    await audit(req, {
      action: 'trainer.update',
      entity: 'trainer',
      entityId: trainer.id,
      entityLabel: trainer.name,
      before: {
        name: trainer.name,
        phone: trainer.phone,
        specialization: trainer.specialization,
        commissionPercentage: Number(trainer.commissionPercentage),
        ptFee: feeOf(trainer.ptFee),
      },
      after: {
        name: updated.name,
        phone: updated.phone,
        specialization: updated.specialization,
        commissionPercentage: Number(updated.commissionPercentage),
        ptFee: feeOf(updated.ptFee),
      },
    });

    res.json({
      ...updated,
      commissionPercentage: Number(updated.commissionPercentage),
      ptFee: feeOf(updated.ptFee),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Soft deletes (deactivates) a trainer so history remains clean.
 */
export const remove = async (
  req: AuthedRequest<IdParam>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  try {
    const trainer = await prisma.trainer.findFirst({
      where: { id, gymId: req.gymId },
    });
    if (!trainer) {
      res.status(404).json({ error: 'Trainer not found' });
      return;
    }

    const updated = await prisma.trainer.update({
      where: { id },
      data: { isActive: false },
    });

    await audit(req, {
      action: 'trainer.delete',
      entity: 'trainer',
      entityId: trainer.id,
      entityLabel: trainer.name,
      before: { isActive: trainer.isActive },
      after: { isActive: false },
    });

    res.json({ success: true, message: 'Trainer deactivated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
