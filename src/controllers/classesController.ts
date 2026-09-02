import type { Response } from 'express';
import prisma from '../db.js';
import { audit } from '../services/audit.js';
import type { AuthedRequest } from '../types.js';
import type {
  CreateClassBody, CreateClassScheduleBody, ClassQuery, IdParam,
} from '../schemas.js';

/**
 * Returns all group classes.
 */
export const getAll = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, ClassQuery>,
  res: Response,
): Promise<void> => {
  const { search, page, limit, all } = req.query;
  try {
    const where = {
      gymId: req.gymId,
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' as const } },
          { description: { contains: search, mode: 'insensitive' as const } },
        ],
      }),
    };

    const [classes, total] = await Promise.all([
      prisma.class.findMany({
        where,
        orderBy: { name: 'asc' },
        // The schedule form picks a class from a dropdown: one that stopped at
        // the first page would make later classes impossible to timetable.
        ...(all ? {} : { skip: (page - 1) * limit, take: limit }),
      }),
      prisma.class.count({ where }),
    ]);

    res.json({
      data: classes,
      total,
      page: all ? 1 : page,
      limit: all ? classes.length : limit,
      hasMore: all ? false : page * limit < total,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Creates a new class program.
 */
export const create = async (
  req: AuthedRequest<unknown, unknown, CreateClassBody>,
  res: Response,
): Promise<void> => {
  const { name, description } = req.body;
  try {
    const createdClass = await prisma.class.create({
      data: {
        gymId: req.gymId,
        name,
        description,
      },
    });

    await audit(req, {
      action: 'class.create',
      entity: 'class',
      entityId: createdClass.id,
      entityLabel: createdClass.name,
      after: { name, description },
    });

    res.status(201).json(createdClass);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Returns all weekly recurring schedules.
 */
export const getSchedules = async (
  req: AuthedRequest,
  res: Response,
): Promise<void> => {
  const { date } = req.query;
  const targetDate = date ? new Date(String(date)) : new Date();
  
  try {
    const schedules = await prisma.classSchedule.findMany({
      where: { gymId: req.gymId, isActive: true },
      include: {
        class: { select: { id: true, name: true, description: true } },
        trainer: { select: { id: true, name: true } },
        bookings: {
          where: {
            bookingDate: {
              equals: targetDate,
            },
            status: { not: 'cancelled' },
          },
          select: { id: true },
        },
      },
      orderBy: [
        { dayOfWeek: 'asc' },
        { startTime: 'asc' },
      ],
    });

    const result = schedules.map(s => ({
      id: s.id,
      classId: s.classId,
      className: s.class.name,
      classDescription: s.class.description,
      trainer: s.trainer ? { id: s.trainer.id, name: s.trainer.name } : null,
      dayOfWeek: s.dayOfWeek,
      startTime: s.startTime,
      endTime: s.endTime,
      capacity: s.capacity,
      bookingsCount: s.bookings.length,
      remainingCapacity: Math.max(0, s.capacity - s.bookings.length),
    }));

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Creates a weekly schedule instance.
 */
export const createSchedule = async (
  req: AuthedRequest<unknown, unknown, CreateClassScheduleBody>,
  res: Response,
): Promise<void> => {
  const { classId, trainerId, dayOfWeek, startTime, endTime, capacity } = req.body;
  try {
    const classExists = await prisma.class.findFirst({
      where: { id: classId, gymId: req.gymId, isActive: true },
    });
    if (!classExists) {
      res.status(404).json({ error: 'Class not found' });
      return;
    }

    if (trainerId) {
      const trainerExists = await prisma.trainer.findFirst({
        where: { id: trainerId, gymId: req.gymId, isActive: true },
      });
      if (!trainerExists) {
        res.status(404).json({ error: 'Trainer not found' });
        return;
      }
    }

    const schedule = await prisma.classSchedule.create({
      data: {
        gymId: req.gymId,
        classId,
        trainerId: trainerId || null,
        dayOfWeek,
        startTime,
        endTime,
        capacity,
      },
      include: {
        class: { select: { name: true } },
        trainer: { select: { name: true } },
      },
    });

    await audit(req, {
      action: 'classSchedule.create',
      entity: 'classSchedule',
      entityId: schedule.id,
      entityLabel: `${schedule.class.name} on ${schedule.dayOfWeek} at ${schedule.startTime}`,
      after: {
        classId,
        trainerId,
        dayOfWeek,
        startTime,
        endTime,
        capacity,
      },
    });

    res.status(201).json({
      ...schedule,
      className: schedule.class.name,
      trainer: schedule.trainer ? { id: schedule.trainerId!, name: schedule.trainer.name } : null,
      bookingsCount: 0,
      remainingCapacity: capacity,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Deactivates a schedule slot.
 */
export const deleteSchedule = async (
  req: AuthedRequest<IdParam>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  try {
    const schedule = await prisma.classSchedule.findFirst({
      where: { id, gymId: req.gymId },
      include: { class: { select: { name: true } } },
    });
    if (!schedule) {
      res.status(404).json({ error: 'Schedule slot not found' });
      return;
    }

    await prisma.classSchedule.update({
      where: { id },
      data: { isActive: false },
    });

    await audit(req, {
      action: 'classSchedule.delete',
      entity: 'classSchedule',
      entityId: schedule.id,
      entityLabel: `${schedule.class.name} on ${schedule.dayOfWeek} at ${schedule.startTime}`,
    });

    res.json({ success: true, message: 'Schedule slot deactivated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
