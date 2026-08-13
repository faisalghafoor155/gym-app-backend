-- Records reminders that have been sent, so none is sent twice.
--
-- The job runs once a day, but "runs daily" is not the same as "sends once".
-- A restart, a redeploy, or a second backend instance each re-run it, and a
-- member who gets "your membership expires today" three times learns to ignore
-- the first one next month. The unique constraint below is what makes the send
-- idempotent rather than merely scheduled: the row is written in the same
-- transaction as the mail, so a duplicate insert is how a second attempt finds
-- out it has nothing left to do.

CREATE TYPE "ReminderKind" AS ENUM ('membershipExpiry');

CREATE TABLE "ReminderLog" (
  "id"           TEXT NOT NULL,
  "gymId"        TEXT NOT NULL,
  "membershipId" TEXT NOT NULL,
  "kind"         "ReminderKind" NOT NULL,
  -- The day the reminder was *for*, not the instant it went out. A job that
  -- runs twice on one day has to collide; one that runs again tomorrow must
  -- not, or a renewal expiring next month would never be reminded about.
  "sentOn"       DATE NOT NULL,
  -- Copied in rather than joined from Member: an audit of what was actually
  -- sent must stay readable after the address it went to has changed.
  "sentTo"       TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ReminderLog_pkey" PRIMARY KEY ("id")
);

-- The whole point of the table.
CREATE UNIQUE INDEX "ReminderLog_membershipId_kind_sentOn_key"
  ON "ReminderLog"("membershipId", "kind", "sentOn");

-- Serves "what did we send this gym, and when".
CREATE INDEX "ReminderLog_gymId_sentOn_idx" ON "ReminderLog"("gymId", "sentOn");

-- No foreign key to Membership on purpose. The question this table answers is
-- "was this already sent", which stays worth answering after the membership is
-- renewed, superseded or deleted — and a CASCADE would erase exactly the
-- evidence that stops a duplicate going out.
