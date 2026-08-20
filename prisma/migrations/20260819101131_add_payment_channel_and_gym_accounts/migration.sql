-- AlterTable
ALTER TABLE "Gym" ADD COLUMN     "bankAccount" TEXT,
ADD COLUMN     "easypaisaAccount" TEXT,
ADD COLUMN     "jazzcashAccount" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "channel" TEXT,
ADD COLUMN     "reference" TEXT;
