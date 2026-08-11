-- Supplement sales: what actually left the shelf, and for how much.
--
-- Until now `Supplement.stock` was a number somebody typed. It could go up or
-- down with nothing to explain why, so it answered "how many are there" only
-- as well as whoever last edited it remembered. A sale now writes a row and
-- decrements the count in the same transaction, which makes the two agree by
-- construction.
--
-- No monthly stock buckets: what is on the shelf on the 1st is what was there
-- on the 31st. Month-wise reporting filters `soldAt` instead, which stays
-- correct however late it is asked and needs no month-end job to keep honest.

CREATE TABLE "SupplementSale" (
    "id" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,
    "supplementId" TEXT NOT NULL,
    "memberId" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "paymentId" TEXT,
    "soldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "SupplementSale_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupplementSale_paymentId_key" ON "SupplementSale"("paymentId");
CREATE INDEX "SupplementSale_gymId_soldAt_idx" ON "SupplementSale"("gymId", "soldAt");
CREATE INDEX "SupplementSale_supplementId_idx" ON "SupplementSale"("supplementId");
CREATE INDEX "SupplementSale_memberId_idx" ON "SupplementSale"("memberId");

ALTER TABLE "SupplementSale"
  ADD CONSTRAINT "SupplementSale_gymId_fkey"
  FOREIGN KEY ("gymId") REFERENCES "Gym"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SupplementSale"
  ADD CONSTRAINT "SupplementSale_supplementId_fkey"
  FOREIGN KEY ("supplementId") REFERENCES "Supplement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A deleted member must not take the gym's sales history with them: the money
-- was still taken. The sale survives with its buyer forgotten.
ALTER TABLE "SupplementSale"
  ADD CONSTRAINT "SupplementSale_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SupplementSale"
  ADD CONSTRAINT "SupplementSale_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
