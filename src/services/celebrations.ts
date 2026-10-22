import type { GymPlan } from '@prisma/client';
import prisma from '../db.js';
import { addDays, currentMembershipWhere, LAPSED_AFTER_DAYS, startOfDay } from './membership.js';

/**
 * Members with something to celebrate today: a birthday, or another year since
 * they joined.
 *
 * Only members still on the roster — active, with a current membership that
 * has not lapsed. A greeting to somebody who stopped coming a year ago reads
 * as a sales message, and a gym that sends those trains its members to ignore
 * the ones that matter.
 */

export interface Celebrant {
  id: string;
  gymId: string;
  name: string;
  memberNo: string;
  phone: string | null;
  whatsappOptOut: boolean;
  gym: { name: string; plan: GymPlan };
}

export interface Celebrations {
  birthdays: (Celebrant & { turning: number | null })[];
  anniversaries: (Celebrant & { years: number })[];
}

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/**
 * Whether a recurring date falls on `today`.
 *
 * A 29 February date is celebrated on the 28th in a year that has no 29th —
 * otherwise a member born on a leap day would hear from the gym once every
 * four years.
 */
const fallsOn = (month: number, day: number, today: Date): boolean => {
  const tm = today.getMonth();
  const td = today.getDate();
  if (month === tm && day === td) return true;
  return month === 1 && day === 29 && tm === 1 && td === 28 && !isLeap(today.getFullYear());
};

export const celebrationsOn = async (
  now: Date = new Date(),
  gymId?: string,
): Promise<Celebrations> => {
  const today = startOfDay(now);
  const lapsedBefore = addDays(today, -LAPSED_AFTER_DAYS);

  const members = await prisma.member.findMany({
    where: {
      ...(gymId && { gymId }),
      status: 'active',
      memberships: {
        some: { ...currentMembershipWhere, status: 'active', expiryDate: { gte: lapsedBefore } },
      },
    },
    select: {
      id: true,
      gymId: true,
      name: true,
      memberNo: true,
      phone: true,
      whatsappOptOut: true,
      dateOfBirth: true,
      createdAt: true,
      gym: { select: { name: true, plan: true } },
    },
    orderBy: { name: 'asc' },
  });

  const birthdays: Celebrations['birthdays'] = [];
  const anniversaries: Celebrations['anniversaries'] = [];

  for (const { dateOfBirth, createdAt, ...m } of members) {
    // A date of birth is a calendar date, stored as midnight UTC, so its UTC
    // parts are the date the desk typed. Reading local parts would move every
    // birthday a day back west of Greenwich.
    if (dateOfBirth && fallsOn(dateOfBirth.getUTCMonth(), dateOfBirth.getUTCDate(), today)) {
      const turning = today.getFullYear() - dateOfBirth.getUTCFullYear();
      // A birth year that makes no sense (typed as this year) is still a
      // birthday; it just is not worth saying how old.
      birthdays.push({ ...m, turning: turning > 0 && turning < 120 ? turning : null });
    }

    // Joining is a moment, so its local date is the day it happened at the gym.
    const years = today.getFullYear() - createdAt.getFullYear();
    if (years >= 1 && fallsOn(createdAt.getMonth(), createdAt.getDate(), today)) {
      anniversaries.push({ ...m, years });
    }
  }

  return { birthdays, anniversaries };
};
