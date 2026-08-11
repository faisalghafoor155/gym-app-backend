-- Records who took each payment.
--
-- Staff can now take a fee at the counter, but must not read the gym's books.
-- The list endpoint squares that by narrowing staff to the rows they recorded
-- themselves — their own day's takings rather than the gym's income — and this
-- is the column that narrows it.
--
-- Nullable, for two reasons that both have to stay true:
--   * Rows written before this migration have no answer, and inventing one
--     would attribute somebody else's takings to whoever happens to be first
--     in the users table.
--   * ON DELETE SET NULL: removing a staff account gives up the attribution,
--     never the payment. Deleting an employee must not delete the gym's money,
--     and a CASCADE here would do exactly that.
--
-- The consequence is deliberate: an old, unattributed row is invisible to
-- staff and visible to the owner. Staff seeing a payment they cannot account
-- for is the worse failure of the two.

ALTER TABLE "Payment" ADD COLUMN "recordedById" TEXT;

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_recordedById_fkey"
  FOREIGN KEY ("recordedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Serves the staff-scoped list directly: filter by gym and recorder, ordered
-- by date. Without it that query degrades to a scan of the gym's whole
-- payment history on every page load.
CREATE INDEX "Payment_gymId_recordedById_paymentDate_idx"
  ON "Payment"("gymId", "recordedById", "paymentDate");
