-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "feeAmount" DOUBLE PRECISION,
ADD COLUMN     "photo" TEXT;

-- CreateTable
CREATE TABLE "Supplement" (
    "id" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "dosage" TEXT,
    "timing" TEXT,
    "price" DOUBLE PRECISION,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Supplement_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Supplement" ADD CONSTRAINT "Supplement_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "Gym"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
