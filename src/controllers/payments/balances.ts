/** @format */

import type { Response } from "express";
import { membershipBalances, unpaidCharges } from "../../services/balances.js";
import { sum } from "../../services/money.js";
import type { AuthedRequest } from "../../types.js";

/**
 * Everybody who owes the gym money right now — the list the desk works from
 * to collect it.
 *
 * Unlike the monthly unpaid list this has no window: a balance from March is
 * still owed in May. Unlike `/due` it is not limited to expired memberships: a
 * member halfway through a term they paid half of owes the other half today.
 */
export const getBalances = async (
  req: AuthedRequest,
  res: Response,
): Promise<void> => {
  try {
    const [memberships, charges] = await Promise.all([
      membershipBalances({ gymId: req.gymId }),
      unpaidCharges(req.gymId),
    ]);

    const chargeRows = charges.map((p) => ({
      paymentId: p.id,
      member: p.member,
      amount: p.amount.toNumber(),
      notes: p.notes,
      type: p.type,
      paymentDate: p.paymentDate,
    }));

    const total =
      memberships.reduce((t, r) => t + r.outstanding, 0) +
      sum(charges.map((p) => p.amount));

    res.json({
      memberships: memberships.map(({ gymId: _gymId, gym: _gym, ...row }) => row),
      charges: chargeRows,
      // Rounded to the paisa: each figure already is, but adding many binary
      // numbers can leave a stray 0.0000001 that would print as such.
      totalOutstanding: Math.round(total * 100) / 100,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};
