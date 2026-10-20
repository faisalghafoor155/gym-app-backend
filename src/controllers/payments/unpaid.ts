/** @format */

import { MembershipStatus } from "@prisma/client";
import prisma from "../../db.js";
import { toView, withPlan } from "../../services/membership.js";
import { sum } from "../../services/money.js";

/**
 * The members the gym should have been paid by in a given window.
 *
 * A membership counts as belonging to the month if its term overlapped that
 * month at all — started before the month ended, and ran out on or after it
 * began. Overlap rather than "started in" or "expired in", because a member
 * halfway through a three-month term owes for August just as much as one who
 * joined on the 1st, and neither boundary test finds them.
 *
 * `superseded` and `cancelled` terms are left out: the first was replaced by
 * the membership that is being counted instead, so including both would bill
 * the month twice, and the second is a term the gym agreed not to charge for.
 */
export const membershipsCovering = (
  gymId: string,
  start: Date,
  end: Date,
  search?: string,
) => ({
  gymId,
  startDate: { lte: end },
  expiryDate: { gte: start },
  status: {
    in: [
      MembershipStatus.active,
      MembershipStatus.expired,
      MembershipStatus.suspended,
    ],
  },
  ...(search && {
    member: {
      OR: [
        { name: { contains: search, mode: "insensitive" as const } },
        { phone: { contains: search, mode: "insensitive" as const } },
        { memberNo: { contains: search, mode: "insensitive" as const } },
      ],
    },
  }),
});

/**
 * Who still owes for the month, and how much.
 *
 * Driven by memberships rather than by payments, which is the whole point: a
 * member who has paid nothing at all has no payment row, so a query over the
 * payments table cannot see them. They are exactly the people this list is for.
 *
 * What counts as paid is every settled payment attached to that membership —
 * not only the ones dated inside the month. A member who paid August's fee in
 * late July has settled it, and a report that called them a defaulter because
 * the receipt fell a few days outside the window would be sending the gym to
 * collect money it already has.
 */
export const unpaidForMonth = async (
  gymId: string,
  start: Date,
  end: Date,
  search?: string,
) => {
  const memberships = await prisma.membership.findMany({
    // Spread inline rather than passed as a prepared object: Prisma infers the
    // result type from this call site, and a `where` built elsewhere loses the
    // link between the include and what comes back.
    where: { ...membershipsCovering(gymId, start, end, search) },
    include: {
      member: { select: { id: true, name: true, phone: true, memberNo: true } },
      // Settled money only. A row still marked `due` is the debt itself, so
      // counting it as payment would net the shortfall to zero.
      payments: { where: { status: "paid" }, select: { amount: true } },
      ...withPlan,
    },
    orderBy: { expiryDate: "asc" },
  });

  return (
    memberships
      .map((m) => {
        const view = toView(m);
        const paid = sum(m.payments.map((p) => p.amount));
        return {
          memberId: m.member.id,
          memberNo: m.member.memberNo,
          name: m.member.name,
          phone: m.member.phone,
          membership: view,
          expected: view.pricePaid,
          paid,
          // Never negative: overpaying is not a debt, and a "-500 shortfall"
          // would quietly cancel out somebody else's real one in the total.
          shortfall: Math.max(0, view.pricePaid - paid),
        };
      })
      // Fully settled memberships are not part of an unpaid list. Filtered after
      // the sum rather than in SQL because the comparison is against a total
      // Prisma cannot compute in the same query.
      .filter((r) => r.shortfall > 0)
      // Biggest debt first — the order the gym would work the list in.
      .sort((a, b) => b.shortfall - a.shortfall || a.name.localeCompare(b.name))
  );
};

