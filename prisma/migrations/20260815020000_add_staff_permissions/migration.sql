-- CreateEnum for StaffPermission
CREATE TYPE "StaffPermission" AS ENUM ('manager', 'members_manager', 'accountant', 'receptionist', 'inventory_manager');

-- Add staffPermission field to User table. Nullable with no default: a staff
-- account with no level set has no extra grants, and the owner assigns one
-- explicitly. A default level would grant it to every account silently.
ALTER TABLE "User" ADD COLUMN "staffPermission" "StaffPermission";
