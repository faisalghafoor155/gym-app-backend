-- Referrals, promo codes, lockers, supplement cost/low-stock, and two gym
-- settings (referral reward days, inactivity threshold).
--
-- Additive only: new tables, nullable or defaulted columns, new enums.
--
-- Also adds the `growth` GymPlan variant. It was added to schema.prisma in
-- 1e9be02 without a migration, so a database built from migrations alone
-- lacks it and refuses any gym moved onto that plan. IF NOT EXISTS keeps this
-- harmless on databases where it was already added by hand.

-- AlterEnum
ALTER TYPE "GymPlan" ADD VALUE IF NOT EXISTS 'growth';

-- CreateEnum
CREATE TYPE "ReferralRewardStatus" AS ENUM ('pending', 'granted', 'cancelled');

-- CreateEnum
CREATE TYPE "PromoKind" AS ENUM ('percent', 'fixed');

-- AlterTable
ALTER TABLE "Gym" ADD COLUMN     "inactivityDays" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "referralRewardDays" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "referredById" TEXT;

-- AlterTable
ALTER TABLE "Supplement" ADD COLUMN     "costPrice" DECIMAL(10,2),
ADD COLUMN     "lowStockAt" INTEGER NOT NULL DEFAULT 5;

-- AlterTable
ALTER TABLE "SupplementSale" ADD COLUMN     "unitCost" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "ReferralReward" (
    "id" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "referredId" TEXT NOT NULL,
    "status" "ReferralRewardStatus" NOT NULL DEFAULT 'pending',
    "rewardDays" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "membershipId" TEXT,
    "grantedAt" TIMESTAMP(3),
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralReward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromoCode" (
    "id" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "kind" "PromoKind" NOT NULL,
    "value" DECIMAL(10,2) NOT NULL,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "maxUses" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromoCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromoRedemption" (
    "id" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,
    "promoCodeId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "discount" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromoRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Locker" (
    "id" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "location" TEXT,
    "memberId" TEXT,
    "assignedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Locker_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferralReward_referredId_key" ON "ReferralReward"("referredId");

-- CreateIndex
CREATE INDEX "ReferralReward_gymId_status_idx" ON "ReferralReward"("gymId", "status");

-- CreateIndex
CREATE INDEX "ReferralReward_referrerId_idx" ON "ReferralReward"("referrerId");

-- CreateIndex
CREATE UNIQUE INDEX "PromoCode_gymId_code_key" ON "PromoCode"("gymId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PromoRedemption_membershipId_key" ON "PromoRedemption"("membershipId");

-- CreateIndex
CREATE INDEX "PromoRedemption_gymId_createdAt_idx" ON "PromoRedemption"("gymId", "createdAt");

-- CreateIndex
CREATE INDEX "PromoRedemption_promoCodeId_idx" ON "PromoRedemption"("promoCodeId");

-- CreateIndex
CREATE UNIQUE INDEX "Locker_memberId_key" ON "Locker"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "Locker_gymId_number_key" ON "Locker"("gymId", "number");

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralReward" ADD CONSTRAINT "ReferralReward_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "Gym"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralReward" ADD CONSTRAINT "ReferralReward_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralReward" ADD CONSTRAINT "ReferralReward_referredId_fkey" FOREIGN KEY ("referredId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoCode" ADD CONSTRAINT "PromoCode_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "Gym"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Locker" ADD CONSTRAINT "Locker_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "Gym"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Locker" ADD CONSTRAINT "Locker_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

