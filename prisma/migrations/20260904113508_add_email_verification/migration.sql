-- Proving that an address belongs to whoever is using the account.
--
-- Public signup asks for an email and has never checked it. The cost of that
-- is not fraud — a stranger who registers a gym gets their own empty gym and
-- nothing of anybody else's — it is the typo. An owner who signs up as
-- `faisal@gmial.com` has no working password reset, no expiry reminders and no
-- receipts, and discovers all of it at the moment they are locked out.
--
-- Nothing is withheld from an unverified account. The app says the address is
-- unconfirmed and offers to send the link again; that is the whole feature. A
-- gym that signed up this morning has to be able to enrol its first member
-- this morning, and gating that behind an email nobody has opened yet would be
-- a worse problem than the one being solved. It would also be a trap in the
-- deployments where no mail transport is configured at all, where the link
-- goes to the container log — there, blocking would mean nobody can ever get
-- in.
--
-- Every account that already exists is marked verified rather than left null.
--
-- Their addresses were never proven, so this is not strictly true. But the
-- alternative is worse in every direction: everybody who already uses the app
-- would open it tomorrow to a banner asking them to confirm something they did
-- years ago, the resend would mail every one of them at once, and for accounts
-- created by invite it would be asking a second time for something already
-- proven — following a link sent to that address is exactly what verification
-- does. The check is for addresses typed from here on.
--
-- `createdAt` rather than `now()`, so the record says when the account was
-- made rather than when this migration happened to run.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifyTokenAt" TIMESTAMP(3),
ADD COLUMN     "verifyTokenHash" TEXT;

-- Existing accounts keep working exactly as they did.
UPDATE "User" SET "emailVerifiedAt" = "createdAt";
