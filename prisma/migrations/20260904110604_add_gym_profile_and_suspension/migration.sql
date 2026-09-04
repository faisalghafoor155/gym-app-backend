-- Two unrelated things a gym needs before it can be sold to somebody.
--
-- `address` is for the receipt. A printed receipt with no address on it does
-- not look like it came from a business, and the gym's own address was the one
-- thing the receipt could not show — `name` and `ownerName` were already
-- there. One free-text column rather than street/city/postcode: a receipt
-- reproduces an address the way its owner writes it, and the addresses this is
-- for do not decompose the way a form expects. "Shop 4, Al-Rehman Plaza,
-- Peshawar Road, Rawalpindi" has no postcode and its own line breaks.
--
-- `suspendedAt` / `suspendedReason` are the lever for a gym that stops paying.
--
-- Deliberately not the plan column. A tier says how much a gym may do; this
-- says whether it may do anything, and conflating them would mean answering a
-- billing problem by silently downgrading a gym to `free` — where it would
-- keep its 400 members on screen and simply fail at the front desk on the next
-- one. Being stopped with a reason is kinder and easier to support than being
-- shrunk without one.
--
-- Nullable rather than a status enum defaulting to 'active', because the
-- absence of a suspension is the normal state and should not need a value.
-- `suspendedAt` doubles as the flag and as the record of when it happened.
--
-- Nothing is destroyed by a suspension and nothing needs backfilling here:
-- every existing gym has NULL, which is exactly "not suspended".

-- AlterTable
ALTER TABLE "Gym" ADD COLUMN     "address" TEXT,
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspendedReason" TEXT;
