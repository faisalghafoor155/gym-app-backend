import type { Response } from "express";
import prisma from "../db.js";
import type { AuthedRequest } from "../types.js";
import type { TrainerIdParam } from "../schemas.js";
import { audit } from "../services/audit.js";
import { sum } from "../services/money.js";

export const getTrainerPayouts = async (
  req: AuthedRequest,
  res: Response,
): Promise<void> => {
  try {
    const gymId = req.gymId;

    // Fetch all trainers in this gym
    const trainers = await prisma.trainer.findMany({
      where: { gymId },
      include: {
        ptSessions: {
          where: {
            status: "completed",
          },
        },
      },
    });

    const payouts = trainers.map((trainer) => {
      const completedSessions = trainer.ptSessions;
      const totalEarned = sum(completedSessions.map((s) => s.trainerCommission));
      const unpaidCommission = sum(
        completedSessions
          .filter((s) => s.payoutStatus === "unpaid")
          .map((s) => s.trainerCommission),
      );

      const paidCommission = sum(
        completedSessions
          .filter((s) => s.payoutStatus === "paid")
          .map((s) => s.trainerCommission),
      );


      return {
        trainerId: trainer.id,
        trainerName: trainer.name,
        commissionPercentage: Number(trainer.commissionPercentage),
        totalSessionsCount: completedSessions.length,
        totalEarned,
        unpaidCommission,
        paidCommission,
      };
    });

    res.json(payouts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

/** The `:id` in `POST /payouts/:id/pay` is the trainer being paid out. */
export const markPayoutAsPaid = async (
  req: AuthedRequest<TrainerIdParam>,
  res: Response,
): Promise<void> => {
  const { trainerId } = req.params;
  try {
    const gymId = req.gymId;

    // Ensure trainer belongs to this gym
    const trainer = await prisma.trainer.findFirst({
      where: { id: trainerId, gymId },
    });
    if (!trainer) {
      res.status(404).json({ error: "Trainer not found" });
      return;
    }

    // What is about to be settled, read before the update: afterwards there is
    // no way to tell which sessions this payout covered from the rows alone.
    const owed = await prisma.ptSession.findMany({
      where: { gymId, trainerId, status: "completed", payoutStatus: "unpaid" },
      select: { id: true, trainerCommission: true },
    });

    const updateResult = await prisma.ptSession.updateMany({
      where: {
        gymId,
        trainerId,
        status: "completed",
        payoutStatus: "unpaid",
      },
      data: {
        payoutStatus: "paid",
      },
    });

    // Money leaving the gym, so it goes in the trail like every other movement
    // of it. Without this a payout is the one financial act in the app that
    // leaves no record of who authorised it.
    await audit(req, {
      action: "trainer.payout",
      entity: "trainer",
      entityId: trainerId,
      entityLabel: `${trainer.name} · Rs. ${sum(owed.map((s) => s.trainerCommission))}`,
      after: {
        sessions: updateResult.count,
        amount: sum(owed.map((s) => s.trainerCommission)),
        sessionIds: owed.map((s) => s.id),
      },
    });

    res.json({
      message: `Successfully marked sessions as paid`,
      count: updateResult.count,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};
