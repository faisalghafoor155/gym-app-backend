import type { Response } from 'express';
import prisma from '../db.js';
import { audit } from '../services/audit.js';
import type { AuthedRequest } from '../types.js';
import type { CreateTrainerBody, UpdateTrainerBody, IdParam } from '../schemas.js';

/**
 * Returns all trainers inside this gym.
 */
export const getAll = async (
  req: AuthedRequest,
  res: Response,
): Promise<void> => {
  try {
    const trainers = await prisma.trainer.findMany({
      where: { gymId: req.gymId },
      include: {
        _count: {
          select: { members: { where: { status: 'active' } } },
        },
      },
      orderBy: { name: 'asc' },
    });

    const result = trainers.map(t => ({
      id: t.id,
      name: t.name,
      phone: t.phone,
      specialization: t.specialization,
      commissionPercentage: Number(t.commissionPercentage),
      isActive: t.isActive,
      createdAt: t.createdAt,
      activeMembersCount: t._count.members,
    }));

    res.json(result);
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
  const { name, phone, specialization, commissionPercentage } = req.body;
  try {
    const trainer = await prisma.trainer.create({
      data: {
        gymId: req.gymId,
        name,
        phone,
        specialization,
        commissionPercentage,
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
      },
    });

    res.status(201).json({
      ...trainer,
      commissionPercentage: Number(trainer.commissionPercentage),
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
  const { name, phone, specialization, commissionPercentage } = req.body;
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
      },
    });

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
      },
      after: {
        name: updated.name,
        phone: updated.phone,
        specialization: updated.specialization,
        commissionPercentage: Number(updated.commissionPercentage),
      },
    });

    res.json({
      ...updated,
      commissionPercentage: Number(updated.commissionPercentage),
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
