-- Removes Leads & Enquiries, which the gym decided it does not need.
--
-- Drops the Lead table and its status enum. Any enquiries recorded since
-- 20261022120000 are deleted with it — check `SELECT count(*) FROM "Lead"`
-- first on a database where the feature was used.

-- DropForeignKey
ALTER TABLE "Lead" DROP CONSTRAINT "Lead_convertedMemberId_fkey";

-- DropForeignKey
ALTER TABLE "Lead" DROP CONSTRAINT "Lead_createdById_fkey";

-- DropForeignKey
ALTER TABLE "Lead" DROP CONSTRAINT "Lead_gymId_fkey";

-- DropTable
DROP TABLE "Lead";

-- DropEnum
DROP TYPE "LeadStatus";
