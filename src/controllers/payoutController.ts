import type { Response } from "express";
import prisma from "../db.js";
import type { AuthedRequest } from "../types.js";
import type { TrainerIdParam, PayoutQuery } from "../schemas.js";
import { audit } from "../services/audit.js";
import { sum } from "../services/money.js";

/**
 * What each trainer is owed, a page of trainers at a time.
 *
 * The totals are grouped in the database rather than by loading every
 * completed session and reducing it here. That was the real cost of this
 * endpoint: a gym two years in has tens of thousands of sessions, and summing
 * three numbers per trainer does not justify pulling all of them across the
 * wire — nor does paging the trainers help while each one still drags its
 * whole history along behind it.
 */
export const getTrainerPayouts = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, PayoutQuery>,
  res: Response,
): Promise<void> => {
  const { search, activeOnly, page, limit, all } = req.query;
  try {
    const gymId = req.gymId;

    // Every trainer by default, including the ones who have left. A departed
    // trainer stays on this list until somebody has actually settled with
    // them: leaving does not forfeit commission already earned, and defaulting
    // to the active ones would quietly write off money the gym still owes.
    const where = {
      gymId,
      ...(activeOnly ? { isActive: true } : {}),
      ...(search && {
        OR: [
          { name: { contains: search, mode: "insensitive" as const } },
          { phone: { contains: search, mode: "insensitive" as const } },
        ],
      }),
    };

    const [trainers, total] = await Promise.all([
      prisma.trainer.findMany({
        where,
        select: { id: true, name: true, commissionPercentage: true },
        orderBy: { name: "asc" },
        ...(all ? {} : { skip: (page - 1) * limit, take: limit }),
      }),
      prisma.trainer.count({ where }),
    ]);

    // One grouped query for the page's trainers, rather than one query each:
    // the totals split by payout status, which is the only axis they differ on.
    const trainerIds = trainers.map((t) => t.id);
    const totals = trainerIds.length
      ? await prisma.ptSession.groupBy({
          by: ["trainerId", "payoutStatus"],
          where: {
            gymId,
            status: "completed",
            trainerId: { in: trainerIds },
          },
          _sum: { trainerCommission: true },
          _count: { _all: true },
        })
      : [];

    const byTrainer = new Map<
      string,
      { paid: number; unpaid: number; count: number }
    >();
    for (const row of totals) {
      const entry = byTrainer.get(row.trainerId) ?? {
        paid: 0,
        unpaid: 0,
        count: 0,
      };
      const amount = sum([row._sum.trainerCommission]);
      if (row.payoutStatus === "paid") entry.paid += amount;
      else entry.unpaid += amount;
      entry.count += row._count._all;
      byTrainer.set(row.trainerId, entry);
    }

    const payouts = trainers.map((trainer) => {
      // A trainer who has taken no completed sessions has no row in the
      // grouping at all, which is a zero rather than a gap.
      const t = byTrainer.get(trainer.id) ?? { paid: 0, unpaid: 0, count: 0 };
      return {
        trainerId: trainer.id,
        trainerName: trainer.name,
        commissionPercentage: Number(trainer.commissionPercentage),
        totalSessionsCount: t.count,
        totalEarned: t.paid + t.unpaid,
        unpaidCommission: t.unpaid,
        paidCommission: t.paid,
      };
    });

    res.json({
      data: payouts,
      total,
      page: all ? 1 : page,
      limit: all ? payouts.length : limit,
      hasMore: all ? false : page * limit < total,
    });
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
