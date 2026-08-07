-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('active', 'expired', 'suspended', 'cancelled', 'superseded');

-- AlterTable: per-gym counter behind the readable member numbers.
ALTER TABLE "Gym" ADD COLUMN     "memberSeq" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: membership details move off Member onto Membership.
--
-- Dropping these four columns is irreversible. It is safe only because there
-- is no production data yet — which is precisely why it is being done now.
ALTER TABLE "Member" DROP COLUMN "membershipType",
                     DROP COLUMN "feeAmount",
                     DROP COLUMN "startDate",
                     DROP COLUMN "endDate";

DROP INDEX IF EXISTS "Member_gymId_endDate_idx";

-- AlterTable: the fields the front desk actually asks a new member for.
ALTER TABLE "Member" ADD COLUMN     "gender" TEXT,
                     ADD COLUMN     "dateOfBirth" TIMESTAMP(3),
                     ADD COLUMN     "address" TEXT,
                     ADD COLUMN     "emergencyContact" TEXT;

-- Backfill memberNo before the NOT NULL constraint lands, so an existing dev
-- database is not left with an unsatisfiable column. Numbering restarts per
-- gym, matching how new members will be numbered from here on.
ALTER TABLE "Member" ADD COLUMN     "memberNo" TEXT;

UPDATE "Member" m
SET "memberNo" = 'MEM-' || LPAD(seq.rn::text, 5, '0')
FROM (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "gymId" ORDER BY "createdAt", "id") AS rn
  FROM "Member"
) seq
WHERE m."id" = seq."id";

-- Move each gym's counter past the numbers just handed out.
UPDATE "Gym" g
SET "memberSeq" = COALESCE(c.n, 0)
FROM (SELECT "gymId", COUNT(*) AS n FROM "Member" GROUP BY "gymId") c
WHERE g."id" = c."gymId";

ALTER TABLE "Member" ALTER COLUMN "memberNo" SET NOT NULL;

-- CreateTable
CREATE TABLE "MembershipPlan" (
    "id" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MembershipPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "expiryDate" TIMESTAMP(3) NOT NULL,
    "originalExpiryDate" TIMESTAMP(3) NOT NULL,
    "pricePaid" DOUBLE PRECISION NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'active',
    "extendedDays" INTEGER NOT NULL DEFAULT 0,
    "extensionReason" TEXT,
    "extendedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "actorRole" "Role" NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityLabel" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Member_gymId_memberNo_key" ON "Member"("gymId", "memberNo");

-- CreateIndex
CREATE INDEX "MembershipPlan_gymId_idx" ON "MembershipPlan"("gymId");
CREATE INDEX "MembershipPlan_gymId_isActive_idx" ON "MembershipPlan"("gymId", "isActive");

-- CreateIndex
CREATE INDEX "Membership_gymId_idx" ON "Membership"("gymId");
CREATE INDEX "Membership_memberId_idx" ON "Membership"("memberId");
CREATE INDEX "Membership_gymId_status_idx" ON "Membership"("gymId", "status");
CREATE INDEX "Membership_gymId_expiryDate_idx" ON "Membership"("gymId", "expiryDate");

-- CreateIndex
CREATE INDEX "AuditLog_gymId_createdAt_idx" ON "AuditLog"("gymId", "createdAt");
CREATE INDEX "AuditLog_gymId_entity_createdAt_idx" ON "AuditLog"("gymId", "entity", "createdAt");
CREATE INDEX "AuditLog_gymId_actorId_createdAt_idx" ON "AuditLog"("gymId", "actorId", "createdAt");

-- AddForeignKey
ALTER TABLE "MembershipPlan" ADD CONSTRAINT "MembershipPlan_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "Gym"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "Gym"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MembershipPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "Gym"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
