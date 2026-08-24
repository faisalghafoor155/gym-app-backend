/** @format */

import type { StaffPermission } from "@prisma/client";

/**
 * Permission-based access control for staff roles.
 *
 * **This file is the source of truth.** The client needs the same table to
 * decide what to render, and it used to be a hand-maintained second copy at
 * `frontend/src/utils/permissions.generated.ts` — two 150-line files that had
 * to be edited in lockstep and had already begun to diverge. That copy is now
 * generated from this one by `npm run gen:permissions`, and
 * `tests/services/permissions.test.ts` fails if the two fall out of step.
 *
 * So: change the table here, run the generator, commit both.
 */

export interface PermissionRequirements {
  canManageMembers: boolean;
  canManageMemberships: boolean;
  canManagePayments: boolean;
  canViewPayments: boolean;
  canRecordPayments: boolean;
  canCheckIn: boolean;
  canViewAttendance: boolean;
  canManageSupplements: boolean;
  canSellSupplements: boolean;
  canManagePlans: boolean;
  canViewReports: boolean;
  canManageStaff: boolean;
  canModifyStaff: boolean;
  canManageTrainers: boolean;
  canManageClasses: boolean;
  canManageExpenses: boolean;
}

/** Every capability, denied. Each level below grants up from here. */
const NONE: PermissionRequirements = {
  canManageMembers: false,
  canManageMemberships: false,
  canManagePayments: false,
  canViewPayments: false,
  canRecordPayments: false,
  canCheckIn: false,
  canViewAttendance: false,
  canManageSupplements: false,
  canSellSupplements: false,
  canManagePlans: false,
  canViewReports: false,
  canManageStaff: false,
  canModifyStaff: false,
  canManageTrainers: false,
  canManageClasses: false,
  canManageExpenses: false,
};

/**
 * What each staff level may do.
 *
 * Written as data rather than as a switch so the generator can serialise it
 * and the test can compare it field by field. Only the granted capabilities
 * are listed; everything absent is denied by `NONE`. A `false` written out
 * explicitly would say the same thing as leaving it out, which is exactly the
 * kind of difference that made the two copies look like they disagreed when
 * they did not.
 */
export const STAFF_PERMISSIONS: Record<StaffPermission, PermissionRequirements> = {
  /** Everything, including staff management. */
  manager: {
    canManageMembers: true,
    canManageMemberships: true,
    canManagePayments: true,
    canViewPayments: true,
    canRecordPayments: true,
    canCheckIn: true,
    canViewAttendance: true,
    canManageSupplements: true,
    canSellSupplements: true,
    canManagePlans: true,
    canViewReports: true,
    canManageStaff: true,
    canModifyStaff: true,
    canManageTrainers: true,
    canManageClasses: true,
    canManageExpenses: true,
  },

  /** Members and memberships. Can see payments, but not the gym's reports. */
  members_manager: {
    ...NONE,
    canManageMembers: true,
    canManageMemberships: true,
    canViewPayments: true,
    canManageClasses: true,
  },

  /** The books: payments and reports. Memberships are read-only — selling one
   *  is the front desk's job, not the bookkeeper's. */
  accountant: {
    ...NONE,
    canCheckIn: true,
    canViewAttendance: true,
    canManagePayments: true,
    canViewPayments: true,
    canRecordPayments: true,
    canViewReports: true,
    canManageTrainers: true,
    canManageExpenses: true,
  },

  /** The front desk: check-ins and attendance. Sees payments without being
   *  able to record them, so a receptionist can answer "have I paid?" without
   *  being able to answer it in the affirmative themselves. */
  receptionist: {
    ...NONE,
    canCheckIn: true,
    canViewAttendance: true,
    canViewPayments: true,
    canManageClasses: true,
  },

  /** Stock and the counter it is sold over. */
  inventory_manager: {
    ...NONE,
    canManageSupplements: true,
    canSellSupplements: true,
    canRecordPayments: true,
    canViewPayments: true,
  },
};

/** Get permissions for a staff permission level. */
export const getStaffPermissions = (
  staffPermission: StaffPermission,
): PermissionRequirements => STAFF_PERMISSIONS[staffPermission] ?? NONE;

/** Check if a user has permission to perform an action. */
export const hasPermission = (
  staffPermission: StaffPermission,
  action: keyof PermissionRequirements,
): boolean => getStaffPermissions(staffPermission)[action];

/** Get readable name for a permission level. */
export const getPermissionLabel = (permission: StaffPermission): string =>
  PERMISSION_LABELS[permission];

/** Describe what a permission level can do. */
export const getPermissionDescription = (permission: StaffPermission): string =>
  PERMISSION_DESCRIPTIONS[permission];

export const PERMISSION_LABELS: Record<StaffPermission, string> = {
  manager: "Full Access",
  members_manager: "Members Manager",
  accountant: "Account",
  receptionist: "Attendance",
  inventory_manager: "Inventory Manager",
};

export const PERMISSION_DESCRIPTIONS: Record<StaffPermission, string> = {
  manager: "Full access to all features including staff management",
  members_manager: "Can manage members, memberships, and view payments",
  accountant: "Can check attendance, record payments (add fees), manage expenses, and view reports",
  receptionist: "Can check in members, view attendance, and view classes/schedules",
  inventory_manager: "Can manage supplements, inventory, and sell items",
};
