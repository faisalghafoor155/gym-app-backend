/** @format */

import { hasPermission } from "../../services/permissions.js";
import type { AuthedRequest } from "../../types.js";

/**
 * What this request is allowed to see of the payments table.
 *
 * The owner sees the gym's money. Staff with the 'canViewPayments' permission
 * also see everything. Other staff see only what they took themselves —
 * enough to check their own counter against their own till, and not the gym's
 * income.
 */
export const visibleTo = (req: AuthedRequest) => {
  if (req.role === "owner") return {};

  // If staff has permission to view all payments, don't filter by recordedById
  if (
    req.staffPermission &&
    hasPermission(req.staffPermission, "canViewPayments")
  ) {
    return {};
  }

  return { recordedById: req.userId };
};
