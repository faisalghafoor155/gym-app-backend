-- AlterTable
ALTER TABLE "SubscriptionInvoice" ADD COLUMN     "lastNoticeAt" TIMESTAMP(3),
ADD COLUMN     "lastNoticeDaysBefore" INTEGER;

