import type { Response } from 'express';
import prisma from '../db.js';
import { audit } from '../services/audit.js';
import type { AuthedRequest } from '../types.js';
import type { CreatePtSessionBody, UpdatePtSessionBody, IdParam } from '../schemas.js';
import { sum } from '../services/money.js';

/**
 * Returns list of PT sessions.
 */
export const getAll = async (
  req: AuthedRequest,
  res: Response,
): Promise<void> => {
  const { trainerId, memberId, status, paymentStatus } = req.query;
  const trainerIdStr = typeof trainerId === 'string' ? trainerId : undefined;
  const memberIdStr = typeof memberId === 'string' ? memberId : undefined;
  const statusStr = typeof status === 'string' ? status : undefined;
  const paymentStatusStr = typeof paymentStatus === 'string' ? paymentStatus : undefined;

  try {
    const sessions = await prisma.ptSession.findMany({
      where: {
        gymId: req.gymId,
        ...(trainerIdStr && { trainerId: trainerIdStr }),
        ...(memberIdStr && { memberId: memberIdStr }),
        ...(statusStr && { status: statusStr }),
        ...(paymentStatusStr && { paymentStatus: paymentStatusStr }),
      },
      include: {
        member: { select: { id: true, name: true, memberNo: true } },
        trainer: { select: { id: true, name: true, specialization: true } },
      },
      orderBy: { sessionDate: 'desc' },
    });

    const result = sessions.map(s => ({
      id: s.id,
      member: s.member,
      trainer: s.trainer,
      sessionDate: s.sessionDate,
      priceCharged: Number(s.priceCharged),
      trainerCommission: Number(s.trainerCommission),
      status: s.status,
      paymentStatus: s.paymentStatus,
      createdAt: s.createdAt,
    }));

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Records/books a new PT session.
 */
export const create = async (
  req: AuthedRequest<unknown, unknown, CreatePtSessionBody>,
  res: Response,
): Promise<void> => {
  const { memberId, trainerId, sessionDate, priceCharged, status, paymentStatus } = req.body;
  try {
    const member = await prisma.member.findFirst({
      where: { id: memberId, gymId: req.gymId },
    });
    if (!member) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    const trainer = await prisma.trainer.findFirst({
      where: { id: trainerId, gymId: req.gymId, isActive: true },
    });
    if (!trainer) {
      res.status(404).json({ error: 'Trainer not found or inactive' });
      return;
    }

    // Calculate commission
    const commissionPct = Number(trainer.commissionPercentage);
    const trainerCommission = (priceCharged * commissionPct) / 100;

    const { session, payment } = await prisma.$transaction(async (tx) => {
      const createdSession = await tx.ptSession.create({
        data: {
          gymId: req.gymId,
          memberId,
          trainerId,
          sessionDate,
          priceCharged,
          trainerCommission,
          status,
          paymentStatus,
        },
        include: {
          member: { select: { id: true, name: true, memberNo: true } },
          trainer: { select: { id: true, name: true } },
        },
      });

      let createdPayment = null;
      if (paymentStatus === 'paid') {
        createdPayment = await tx.payment.create({
          data: {
            gymId: req.gymId,
            memberId,
            amount: priceCharged,
            type: 'other',
            method: 'cash',
            status: 'paid',
            paymentDate: sessionDate,
            notes: `PT Session with Trainer: ${trainer.name}`,
            recordedById: req.userId,
          },
        });
      }

      return { session: createdSession, payment: createdPayment };
    });

    await audit(req, {
      action: 'pt-session.create',
      entity: 'ptSession',
      entityId: session.id,
      entityLabel: `${session.member.name} with ${session.trainer.name}`,
      after: {
        memberId,
        trainerId,
        sessionDate,
        priceCharged,
        trainerCommission,
        status,
        paymentStatus,
        ...(payment && { paymentId: payment.id }),
      },
    });

    res.status(201).json({
      ...session,
      priceCharged: Number(session.priceCharged),
      trainerCommission: Number(session.trainerCommission),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Updates an existing PT session status or payment.
 */
export const update = async (
  req: AuthedRequest<IdParam, unknown, UpdatePtSessionBody>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  const { sessionDate, status, paymentStatus } = req.body;
  try {
    const session = await prisma.ptSession.findFirst({
      where: { id, gymId: req.gymId },
      include: {
        member: { select: { name: true } },
        trainer: { select: { name: true } },
      },
    });
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const { updated } = await prisma.$transaction(async (tx) => {
      const updatedSession = await tx.ptSession.update({
        where: { id },
        data: {
          ...(sessionDate !== undefined && { sessionDate }),
          ...(status !== undefined && { status }),
          ...(paymentStatus !== undefined && { paymentStatus }),
        },
      });

      // If changed to paid, log a payment
      if (paymentStatus === 'paid' && session.paymentStatus !== 'paid') {
        await tx.payment.create({
          data: {
            gymId: req.gymId,
            memberId: session.memberId,
            amount: session.priceCharged,
            type: 'other',
            method: 'cash',
            status: 'paid',
            paymentDate: sessionDate ?? session.sessionDate,
            notes: `PT Session with Trainer: ${session.trainer.name}`,
            recordedById: req.userId,
          },
        });
      }

      return { updated: updatedSession };
    });

    await audit(req, {
      action: 'pt-session.update',
      entity: 'ptSession',
      entityId: session.id,
      entityLabel: `${session.member.name} with ${session.trainer.name}`,
      before: {
        sessionDate: session.sessionDate,
        status: session.status,
        paymentStatus: session.paymentStatus,
      },
      after: {
        sessionDate: updated.sessionDate,
        status: updated.status,
        paymentStatus: updated.paymentStatus,
      },
    });

    res.json({
      ...updated,
      priceCharged: Number(updated.priceCharged),
      trainerCommission: Number(updated.trainerCommission),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Returns commission summary report grouped by trainer.
 */
export const getCommissionsReport = async (
  req: AuthedRequest,
  res: Response,
): Promise<void> => {
  try {
    const trainers = await prisma.trainer.findMany({
      where: { gymId: req.gymId },
      include: {
        ptSessions: {
          where: { status: 'completed' },
          select: { priceCharged: true, trainerCommission: true },
        },
      },
    });

    const report = trainers.map(t => {
      const totalSessions = t.ptSessions.length;
      const totalRevenue = sum(t.ptSessions.map(curr => curr.priceCharged));
      const totalCommission = sum(t.ptSessions.map(curr => curr.trainerCommission));


      return {
        trainerId: t.id,
        trainerName: t.name,
        specialization: t.specialization,
        commissionPercentage: Number(t.commissionPercentage),
        totalSessions,
        totalRevenue,
        totalCommission,
      };
    });

    res.json(report);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
