/** @format */

import type { StaffPermission } from "@prisma/client";

/**
 * Permission-based access control for staff roles
 * Defines what each staff permission level can do
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
}

/**
 * Get permissions for a staff permission level
 */
export const getStaffPermissions = (
  staffPermission: StaffPermission,
): PermissionRequirements => {
  const basePermissions: PermissionRequirements = {
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
  };

  switch (staffPermission) {
    case "manager":
      // Manager has access to everything
      return {
        ...basePermissions,
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
      };

    case "members_manager":
      // Can manage members and memberships only
      return {
        ...basePermissions,
        canManageMembers: true,
        canManageMemberships: true,
        canViewPayments: true,
        canViewReports: false, // Can't access reports
      };

    case "accountant":
      // Can manage and view payments, can view memberships but not create
      return {
        ...basePermissions,
        canManagePayments: true,
        canViewPayments: true,
        canRecordPayments: true,
        canViewReports: true,
        canManageMemberships: false, // Read-only on memberships
        canManageTrainers: true,
      };

    case "receptionist":
      // Can check in members and view attendance
      return {
        ...basePermissions,
        canCheckIn: true,
        canViewAttendance: true,
        canRecordPayments: false, // Can't record payments
        canViewPayments: true, // Can view but not record
      };

    case "inventory_manager":
      // Can manage supplements and inventory
      return {
        ...basePermissions,
        canManageSupplements: true,
        canSellSupplements: true,
        canRecordPayments: true, // Can record supplement sales
        canViewPayments: true,
      };

    default:
      return basePermissions;
  }
};

/**
 * Check if a user has permission to perform an action
 */
export const hasPermission = (
  staffPermission: StaffPermission,
  action: keyof PermissionRequirements,
): boolean => {
  const permissions = getStaffPermissions(staffPermission);
  return permissions[action];
};

/**
 * Get readable name for a permission level
 */
export const getPermissionLabel = (permission: StaffPermission): string => {
  const labels: { [key in StaffPermission]: string } = {
    manager: "Manager",
    members_manager: "Members Manager",
    accountant: "Accountant",
    receptionist: "Receptionist",
    inventory_manager: "Inventory Manager",
  };
  return labels[permission];
};

/**
 * Describe what a permission level can do
 */
export const getPermissionDescription = (
  permission: StaffPermission,
): string => {
  const descriptions: { [key in StaffPermission]: string } = {
    manager: "Full access to all features including staff management",
    members_manager: "Can manage members, memberships, and view payments",
    accountant: "Can manage and view payments and reports",
    receptionist: "Can check in members and view attendance",
    inventory_manager: "Can manage supplements, inventory, and sell items",
  };
  return descriptions[permission];
};
