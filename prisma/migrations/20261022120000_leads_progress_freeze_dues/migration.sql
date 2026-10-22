-- Leads, member progress, membership freezes, dues reminders and greetings.
--
-- Additive only: new tables, two nullable columns on Membership and one new
-- enum value. Nothing existing is rewritten, so there is no data to back up
-- before running it.
--
-- `ADD VALUE` on ReminderKind is safe inside the migration's transaction on
-- Postgres 12+, as long as nothing in the same transaction uses the new
-- value — nothing here does.

-- CreateEnum
CREATE TYPE "GreetingKind" AS ENUM ('birthday', 'anniversary');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('new', 'contacted', 'trial', 'converted', 'lost');

-- AlterEnum
ALTER TYPE "ReminderKind" ADD VALUE 'duesOutstanding';

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "frozenFrom" TIMESTAMP(3),
ADD COLUMN     "frozenUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MembershipFreeze" (
    "id" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "days" INTEGER NOT NULL,
    "endedEarlyOn" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MembershipFreeze_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GreetingLog" (
    "id" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "kind" "GreetingKind" NOT NULL,
    "channel" "ReminderChannel" NOT NULL,
    "year" INTEGER NOT NULL,
    "sentTo" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GreetingLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "source" TEXT NOT NULL DEFAULT 'walk-in',
    "interest" TEXT,
    "notes" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'new',
    "followUpOn" TIMESTAMP(3),
    "convertedMemberId" TEXT,
    "convertedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberMeasurement" (
    "id" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "measuredOn" TIMESTAMP(3) NOT NULL,
    "weightKg" DECIMAL(5,1),
    "bodyFatPct" DECIMAL(4,1),
    "chestCm" DECIMAL(5,1),
    "waistCm" DECIMAL(5,1),
    "hipsCm" DECIMAL(5,1),
    "armCm" DECIMAL(5,1),
    "thighCm" DECIMAL(5,1),
    "photoKey" TEXT,
    "photo" TEXT,
    "notes" TEXT,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberMeasurement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MembershipFreeze_gymId_idx" ON "MembershipFreeze"("gymId");

-- CreateIndex
CREATE INDEX "MembershipFreeze_membershipId_idx" ON "MembershipFreeze"("membershipId");

-- CreateIndex
CREATE INDEX "GreetingLog_gymId_createdAt_idx" ON "GreetingLog"("gymId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GreetingLog_memberId_kind_year_channel_key" ON "GreetingLog"("memberId", "kind", "year", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_convertedMemberId_key" ON "Lead"("convertedMemberId");

-- CreateIndex
CREATE INDEX "Lead_gymId_status_idx" ON "Lead"("gymId", "status");

-- CreateIndex
CREATE INDEX "Lead_gymId_followUpOn_idx" ON "Lead"("gymId", "followUpOn");

-- CreateIndex
CREATE INDEX "MemberMeasurement_gymId_idx" ON "MemberMeasurement"("gymId");

-- CreateIndex
CREATE INDEX "MemberMeasurement_memberId_measuredOn_idx" ON "MemberMeasurement"("memberId", "measuredOn");

-- CreateIndex
CREATE INDEX "ReminderLog_membershipId_kind_idx" ON "ReminderLog"("membershipId", "kind");

-- AddForeignKey
ALTER TABLE "MembershipFreeze" ADD CONSTRAINT "MembershipFreeze_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "Gym"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_convertedMemberId_fkey" FOREIGN KEY ("convertedMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberMeasurement" ADD CONSTRAINT "MemberMeasurement_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "Gym"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberMeasurement" ADD CONSTRAINT "MemberMeasurement_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberMeasurement" ADD CONSTRAINT "MemberMeasurement_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

