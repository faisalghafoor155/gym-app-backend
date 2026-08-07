-- AlterTable
ALTER TABLE "User" ADD COLUMN     "inviteTokenHash" TEXT,
ADD COLUMN     "inviteTokenAt" TIMESTAMP(3);
