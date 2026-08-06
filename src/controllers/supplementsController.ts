import type { Response } from 'express';
import prisma from '../db.js';
import type { AuthedRequest } from '../types.js';
import type { CreateSupplementBody, UpdateSupplementBody, IdParam } from '../schemas.js';

export const getAll = async (req: AuthedRequest, res: Response): Promise<void> => {
  try {
    const supplements = await prisma.supplement.findMany({
      where: { gymId: req.gymId },
      orderBy: { createdAt: 'desc' },
    });
    res.json(supplements);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const create = async (
  req: AuthedRequest<Record<string, string>, unknown, CreateSupplementBody>,
  res: Response,
): Promise<void> => {
  // Already validated and coerced by the route's schema.
  const { name, category, description, dosage, timing, price, stock } = req.body;
  try {
    const supplement = await prisma.supplement.create({
      data: {
        gymId: req.gymId,
        name, category,
        description: description ?? null,
        dosage: dosage ?? null,
        timing: timing ?? null,
        price: price ?? null,
        stock: stock ?? 0,
      },
    });
    res.status(201).json(supplement);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const update = async (
  req: AuthedRequest<IdParam, unknown, UpdateSupplementBody>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  const { name, category, description, dosage, timing, price, stock } = req.body;
  try {
    const existing = await prisma.supplement.findFirst({ where: { id, gymId: req.gymId } });
    if (!existing) {
      res.status(404).json({ error: 'Supplement not found' });
      return;
    }

    const supplement = await prisma.supplement.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(category && { category }),
        ...(description !== undefined && { description }),
        ...(dosage !== undefined && { dosage }),
        ...(timing !== undefined && { timing }),
        ...(price !== undefined && { price: price ?? null }),
        ...(stock !== undefined && { stock: stock ?? 0 }),
      },
    });
    res.json(supplement);
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
    const existing = await prisma.supplement.findFirst({ where: { id, gymId: req.gymId } });
    if (!existing) {
      res.status(404).json({ error: 'Supplement not found' });
      return;
    }
    await prisma.supplement.delete({ where: { id } });
    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
