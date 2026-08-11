-- Money moves from DOUBLE PRECISION to DECIMAL(10,2).
--
-- Floating point cannot represent 0.1 exactly, so a column of payments adds up
-- to something a few paisa off the ledger it is meant to reconcile with. The
-- error is invisible on one row and compounds across a year of them.
--
-- Postgres casts double -> numeric row by row and rounds to the target scale,
-- so existing values survive: 2500 stays 2500.00. Anything already carrying
-- float noise (2499.9999999999995) rounds to the value it was always meant to
-- be. The cast is why this runs as plain ALTERs rather than add-copy-drop.
--
-- DECIMAL(10,2) caps a single amount at 99,999,999.99, which matches the
-- application-level limit already enforced by the Zod `money` schema.

ALTER TABLE "MembershipPlan"
  ALTER COLUMN "price" TYPE DECIMAL(10,2) USING "price"::numeric;

ALTER TABLE "Membership"
  ALTER COLUMN "pricePaid" TYPE DECIMAL(10,2) USING "pricePaid"::numeric;

ALTER TABLE "Payment"
  ALTER COLUMN "amount" TYPE DECIMAL(10,2) USING "amount"::numeric;

ALTER TABLE "Supplement"
  ALTER COLUMN "price" TYPE DECIMAL(10,2) USING "price"::numeric;
