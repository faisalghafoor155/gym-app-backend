import { MembershipStatus, type GymPlan, type Prisma } from '@prisma/client';
import prisma from '../db.js';
import { toView, withPlan, type MembershipView } from './membership.js';
import { sum } from './money.js';

/**
 * Who owes the gym money, and how much.
 *
 * There are two kinds of debt in the books, and this reports both:
 *
 *   - a membership sold for more than has been paid against it — the member
 *     paid Rs. 2,000 of a Rs. 5,000 plan at the counter and promised the rest;
 *   - a payment row recorded as `due` that belongs to no membership, such as
 *     a trainer fee the member will pay next week.
 *
 * A `due` row that *does* name a membership is deliberately not counted as a
 * second debt: the membership's shortfall already includes it, since only
 * `paid` rows reduce a shortfall.
 *
 * Only a member's current membership is looked at — the same set the monthly
 * collection uses. A superseded one was replaced by a renewal that is counted
 * instead, and a cancelled one is a term the gym agreed not to charge for.
 */

/** Memberships that can still owe: live, run out, or paused. */
const OWING_STATUSES = [
  MembershipStatus.active,
  MembershipStatus.expired,
  MembershipStatus.suspended,
];

export interface MembershipBalance {
  membershipId: string;
  gymId: string;
  /** For the reminder job, which runs across every gym and has to know each
   *  one's name and whether its plan includes WhatsApp. */
  gym: { name: string; plan: GymPlan };
  member: { id: string; name: string; memberNo: string; phone: string | null; whatsappOptOut: boolean; status: string };
  membership: MembershipView;
  expected: number;
  paid: number;
  outstanding: number;
}

/**
 * Every current membership matching `where` with money still owed on it,
 * biggest debt first.
 *
 * Filtered after the sum rather than in SQL, for the same reason as the
 * monthly unpaid list: the comparison is against a total Prisma cannot
 * compute in the same query. A gym has hundreds of current memberships, not
 * hundreds of thousands, so reading them all is cheap.
 */
export const membershipBalances = async (
  where: Prisma.MembershipWhereInput,
  now: Date = new Date(),
): Promise<MembershipBalance[]> => {
  const memberships = await prisma.membership.findMany({
    where: { ...where, status: { in: OWING_STATUSES } },
    include: {
      ...withPlan,
      member: {
        select: {
          id: true, name: true, memberNo: true, phone: true, whatsappOptOut: true, status: true,
        },
      },
      payments: { where: { status: 'paid' }, select: { amount: true } },
      gym: { select: { name: true, plan: true } },
    },
  });

  return memberships
    .map((m) => {
      const view = toView(m, now);
      const paid = sum(m.payments.map((p) => p.amount));
      return {
        membershipId: m.id,
        gymId: m.gymId,
        gym: m.gym,
        member: m.member,
        membership: view,
        expected: view.pricePaid,
        paid,
        // Never negative: overpaying is not a debt, and a negative row would
        // quietly cancel out somebody else's real one in the total.
        outstanding: Math.max(0, view.pricePaid - paid),
      };
    })
    .filter((r) => r.outstanding > 0)
    .sort((a, b) => b.outstanding - a.outstanding || a.member.name.localeCompare(b.member.name));
};

/** `due` payment rows that stand on their own, newest first. */
export const unpaidCharges = (gymId: string) =>
  prisma.payment.findMany({
    where: { gymId, status: 'due', membershipId: null },
    include: {
      member: { select: { id: true, name: true, memberNo: true, phone: true } },
    },
    orderBy: { paymentDate: 'desc' },
  });
