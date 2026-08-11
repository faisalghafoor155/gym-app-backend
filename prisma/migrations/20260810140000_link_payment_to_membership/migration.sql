-- Ties a payment to the membership it paid for.
--
-- Until now a payment recorded only "this member gave us this much", which
-- cannot answer "is this membership paid for?" — the question the front desk
-- actually asks. The link is nullable because plenty of real money has no
-- membership behind it: a supplement sale, a registration fee, or a renewal
-- recorded as due before the membership is sold.
--
-- `type` sits alongside rather than being derived from the link, because
-- "no membership attached" and "not for a membership" are different facts.

CREATE TYPE "PaymentType" AS ENUM ('membership', 'supplement', 'other');

-- Existing rows are all membership money — the app had no other kind to record
-- — so the default backfills them correctly on the way in.
ALTER TABLE "Payment"
  ADD COLUMN "type" "PaymentType" NOT NULL DEFAULT 'membership',
  ADD COLUMN "membershipId" TEXT;

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_membershipId_fkey"
  FOREIGN KEY ("membershipId") REFERENCES "Membership"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Payment_membershipId_idx" ON "Payment"("membershipId");
CREATE INDEX "Payment_gymId_type_idx" ON "Payment"("gymId", "type");

-- Backfill: every payment taken on the day a membership started is that
-- membership's payment. That is exactly how the app created them — the sale
-- writes the membership and its payment together — so this reconstructs a link
-- that was always true but never stored.
--
-- Matching on the day, not the instant: the two rows are written moments apart
-- and a timestamp comparison would miss every one of them.
--
-- DISTINCT ON picks a single membership per payment, preferring the closest
-- start, so a member who bought twice on one day cannot produce two matches.
UPDATE "Payment" p
SET "membershipId" = m.id
FROM (
  SELECT DISTINCT ON (pay.id) pay.id AS payment_id, ms.id
  FROM "Payment" pay
  JOIN "Membership" ms
    ON ms."memberId" = pay."memberId"
   AND ms."gymId" = pay."gymId"
   AND date_trunc('day', ms."startDate") = date_trunc('day', pay."paymentDate")
  ORDER BY pay.id, ms."startDate" DESC
) m
WHERE p.id = m.payment_id;
