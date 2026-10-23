-- Plans say what they cover beyond the gym floor; lockers can be paid for.
ALTER TYPE "PaymentType" ADD VALUE 'locker';

ALTER TABLE "MembershipPlan" ADD COLUMN "includesCardio" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "includesLocker" BOOLEAN NOT NULL DEFAULT false;
