-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "trainerId" TEXT;

-- CreateTable
CREATE TABLE "Trainer" (
    "id" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "specialization" TEXT,
    "commissionPercentage" DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trainer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PtSession" (
    "id" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "trainerId" TEXT NOT NULL,
    "sessionDate" TIMESTAMP(3) NOT NULL,
    "priceCharged" DECIMAL(10,2) NOT NULL,
    "trainerCommission" DECIMAL(10,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "paymentStatus" TEXT NOT NULL DEFAULT 'unpaid',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PtSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Trainer_gymId_idx" ON "Trainer"("gymId");

-- CreateIndex
CREATE INDEX "PtSession_gymId_idx" ON "PtSession"("gymId");

-- CreateIndex
CREATE INDEX "PtSession_memberId_idx" ON "PtSession"("memberId");

-- CreateIndex
CREATE INDEX "PtSession_trainerId_idx" ON "PtSession"("trainerId");

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_trainerId_fkey" FOREIGN KEY ("trainerId") REFERENCES "Trainer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trainer" ADD CONSTRAINT "Trainer_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "Gym"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PtSession" ADD CONSTRAINT "PtSession_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "Gym"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PtSession" ADD CONSTRAINT "PtSession_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PtSession" ADD CONSTRAINT "PtSession_trainerId_fkey" FOREIGN KEY ("trainerId") REFERENCES "Trainer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
