-- Extend and freeze are gone: the gym renews memberships instead, which sells
-- a fresh period and takes the money for it rather than moving an existing
-- expiry. Nothing wrote these columns anything but their defaults.

-- AlterTable
ALTER TABLE "Membership" DROP COLUMN "originalExpiryDate",
DROP COLUMN "extendedDays",
DROP COLUMN "extensionReason",
DROP COLUMN "extendedBy",
DROP COLUMN "freezeStartDate";
