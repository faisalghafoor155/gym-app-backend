-- AlterTable
ALTER TABLE "Gym" ADD COLUMN     "defaultPtFee" DECIMAL(10,2) NOT NULL DEFAULT 0.00;

-- AlterTable
ALTER TABLE "Trainer" ADD COLUMN     "ptFee" DECIMAL(10,2);

-- The fee used to be hardcoded at Rs. 10,000 in the member controller, so every
-- gym already running is charging exactly that. The column default is 0, which
-- is right for a gym created from here on — but applying it to existing rows
-- would silently drop a real price to nothing on the next trainer assignment.
--
-- Backfilled only where a trainer exists: a gym that never used the feature has
-- no price to preserve and should start from the honest default.
UPDATE "Gym"
SET "defaultPtFee" = 10000.00
WHERE EXISTS (SELECT 1 FROM "Trainer" WHERE "Trainer"."gymId" = "Gym"."id");
