import type { Response } from 'express';
import prisma from '../db.js';
import type { AuthedRequest } from '../types.js';
import type { CreatePlanBody, AssignPlanBody, IdParam } from '../schemas.js';

export const getWorkoutPlans = async (req: AuthedRequest, res: Response): Promise<void> => {
  try {
    const plans = await prisma.workoutPlan.findMany({
      where: { gymId: req.gymId },
      orderBy: { createdAt: 'desc' },
    });
    res.json(plans);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const createWorkoutPlan = async (
  req: AuthedRequest<Record<string, string>, unknown, CreatePlanBody>,
  res: Response,
): Promise<void> => {
  const { name, description } = req.body;
  try {
    const plan = await prisma.workoutPlan.create({
      data: { gymId: req.gymId, name, description },
    });
    res.status(201).json(plan);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const getDietPlans = async (req: AuthedRequest, res: Response): Promise<void> => {
  try {
    const plans = await prisma.dietPlan.findMany({
      where: { gymId: req.gymId },
      orderBy: { createdAt: 'desc' },
    });
    res.json(plans);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const createDietPlan = async (
  req: AuthedRequest<Record<string, string>, unknown, CreatePlanBody>,
  res: Response,
): Promise<void> => {
  const { name, description } = req.body;
  try {
    const plan = await prisma.dietPlan.create({
      data: { gymId: req.gymId, name, description },
    });
    res.status(201).json(plan);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const assignPlan = async (
  req: AuthedRequest<Record<string, string>, unknown, AssignPlanBody>,
  res: Response,
): Promise<void> => {
  const { memberId, workoutPlanId, dietPlanId } = req.body;
  try {
    const member = await prisma.member.findFirst({ where: { id: memberId, gymId: req.gymId } });
    if (!member) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    // MemberPlan has no gymId of its own, so each plan id must be verified
    // against this gym or one gym could attach another gym's plan.
    if (workoutPlanId) {
      const plan = await prisma.workoutPlan.findFirst({
        where: { id: workoutPlanId, gymId: req.gymId },
      });
      if (!plan) {
        res.status(404).json({ error: 'Workout plan not found' });
        return;
      }
    }
    if (dietPlanId) {
      const plan = await prisma.dietPlan.findFirst({
        where: { id: dietPlanId, gymId: req.gymId },
      });
      if (!plan) {
        res.status(404).json({ error: 'Diet plan not found' });
        return;
      }
    }

    const assignment = await prisma.memberPlan.create({
      data: { memberId, workoutPlanId, dietPlanId },
    });
    res.status(201).json(assignment);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const getMemberPlans = async (
  req: AuthedRequest<IdParam>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  try {
    // Scope through the member, since MemberPlan carries no gymId.
    const member = await prisma.member.findFirst({ where: { id, gymId: req.gymId } });
    if (!member) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    const plans = await prisma.memberPlan.findMany({
      where: { memberId: id },
      include: { workoutPlan: true, dietPlan: true },
      orderBy: { assignedAt: 'desc' },
      take: 1,
    });
    res.json(plans[0] ?? null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
