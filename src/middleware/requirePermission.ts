/** @format */

import type { Request, Response, NextFunction } from "express";
import type { StaffPermission } from "@prisma/client";
import { hasPermission } from "../services/permissions.js";
import type { AuthedRequest } from "../types.js";
import type { PermissionRequirements } from "../services/permissions.js";

/**
 * Middleware to require a specific permission
 * Only applies to staff; owners bypass all permission checks
 */
export const requirePermission = (
  requiredPermission: keyof PermissionRequirements,
) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authedReq = req as AuthedRequest;

    // Owners bypass all permission checks
    if (authedReq.role === "owner") {
      next();
      return;
    }

    // Only staff have permissions; members don't have the staffPermission field
    if (authedReq.role !== "staff") {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    const staffPermission = authedReq.staffPermission as
      | StaffPermission
      | undefined;
    if (
      !staffPermission ||
      !hasPermission(staffPermission, requiredPermission)
    ) {
      res.status(403).json({
        error: `Insufficient permissions. You need: ${requiredPermission}`,
      });
      return;
    }

    next();
  };
};

/**
 * Middleware to require multiple permissions (AND logic - must have all)
 */
export const requirePermissions = (
  ...requiredPermissions: (keyof PermissionRequirements)[]
) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authedReq = req as AuthedRequest;

    // Owners bypass all permission checks
    if (authedReq.role === "owner") {
      next();
      return;
    }

    // Only staff have permissions
    if (authedReq.role !== "staff") {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    const staffPermission = authedReq.staffPermission as
      | StaffPermission
      | undefined;
    if (!staffPermission) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    // Check if user has all required permissions
    const hasAllPermissions = requiredPermissions.every((perm) =>
      hasPermission(staffPermission, perm),
    );

    if (!hasAllPermissions) {
      res.status(403).json({
        error: `Insufficient permissions. You need: ${requiredPermissions.join(", ")}`,
      });
      return;
    }

    next();
  };
};

/**
 * Middleware to require any of multiple permissions (OR logic - must have at least one)
 */
export const requireAnyPermission = (
  ...requiredPermissions: (keyof PermissionRequirements)[]
) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authedReq = req as AuthedRequest;

    // Owners bypass all permission checks
    if (authedReq.role === "owner") {
      next();
      return;
    }

    // Only staff have permissions
    if (authedReq.role !== "staff") {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    const staffPermission = authedReq.staffPermission as
      | StaffPermission
      | undefined;
    if (!staffPermission) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    // Check if user has any of the required permissions
    const hasAnyPermission = requiredPermissions.some((perm) =>
      hasPermission(staffPermission, perm),
    );

    if (!hasAnyPermission) {
      res.status(403).json({
        error: `Insufficient permissions. You need one of: ${requiredPermissions.join(", ")}`,
      });
      return;
    }

    next();
  };
};
