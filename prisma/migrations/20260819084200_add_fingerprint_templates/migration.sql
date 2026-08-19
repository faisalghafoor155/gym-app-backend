-- CreateTable
CREATE TABLE "FingerprintTemplate" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,
    "template" BYTEA NOT NULL,
    "format" TEXT NOT NULL,
    "finger" TEXT,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enrolledBy" TEXT,

    CONSTRAINT "FingerprintTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FingerprintTemplate_memberId_key" ON "FingerprintTemplate"("memberId");

-- CreateIndex
CREATE INDEX "FingerprintTemplate_gymId_idx" ON "FingerprintTemplate"("gymId");

-- AddForeignKey
ALTER TABLE "FingerprintTemplate" ADD CONSTRAINT "FingerprintTemplate_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FingerprintTemplate" ADD CONSTRAINT "FingerprintTemplate_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "Gym"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
