-- Introduces the User account model (owner / staff / member), moves the
-- credentials off Gym, and adds the indexes every gym-scoped query needs.

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('owner', 'staff', 'member');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'member',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "memberId" TEXT,
    "googleId" TEXT,
    "resetTokenHash" TEXT,
    "resetTokenAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- Carry every existing gym's credentials over as its owner account, so the
-- accounts that exist today keep working after this migration.
INSERT INTO "User" ("id", "gymId", "email", "passwordHash", "name", "role", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    "id",
    "email",
    "passwordHash",
    "ownerName",
    'owner'::"Role",
    "createdAt",
    CURRENT_TIMESTAMP
FROM "Gym";

-- The credentials now live on User.
ALTER TABLE "Gym" DROP COLUMN "email",
                  DROP COLUMN "passwordHash";

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_memberId_key" ON "User"("memberId");
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
CREATE INDEX "User_gymId_idx" ON "User"("gymId");
CREATE INDEX "User_gymId_role_idx" ON "User"("gymId", "role");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_gymId_fkey"
    FOREIGN KEY ("gymId") REFERENCES "Gym"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "User" ADD CONSTRAINT "User_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Every list query filters on gymId and most sort or range-filter on a date;
-- without these each one is a full table scan.
CREATE INDEX "Member_gymId_idx" ON "Member"("gymId");
CREATE INDEX "Member_gymId_endDate_idx" ON "Member"("gymId", "endDate");
CREATE INDEX "Attendance_gymId_checkedInAt_idx" ON "Attendance"("gymId", "checkedInAt");
CREATE INDEX "Attendance_memberId_idx" ON "Attendance"("memberId");
CREATE INDEX "Payment_gymId_status_idx" ON "Payment"("gymId", "status");
CREATE INDEX "Payment_gymId_paymentDate_idx" ON "Payment"("gymId", "paymentDate");
CREATE INDEX "Payment_memberId_idx" ON "Payment"("memberId");
CREATE INDEX "WorkoutPlan_gymId_idx" ON "WorkoutPlan"("gymId");
CREATE INDEX "DietPlan_gymId_idx" ON "DietPlan"("gymId");
CREATE INDEX "MemberPlan_memberId_idx" ON "MemberPlan"("memberId");
CREATE INDEX "Supplement_gymId_idx" ON "Supplement"("gymId");
