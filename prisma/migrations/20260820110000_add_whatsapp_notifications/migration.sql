-- WhatsApp alongside email. In Pakistan a member reads WhatsApp and rarely
-- opens email, so the notices a gym already sends now go both ways.

-- A member who has asked not to be messaged. Opt-out rather than opt-in: these
-- are the notices somebody joining a gym expects, and requiring consent first
-- would leave most of a roster uninformed about their own membership.
ALTER TABLE "Member" ADD COLUMN "whatsappOptOut" BOOLEAN NOT NULL DEFAULT false;

CREATE TYPE "ReminderChannel" AS ENUM ('email', 'whatsapp');

-- Defaults to email so the rows written before WhatsApp existed keep meaning
-- what they meant when they were written.
ALTER TABLE "ReminderLog"
  ADD COLUMN "channel" "ReminderChannel" NOT NULL DEFAULT 'email';

-- The channel joins the idempotency key rather than sitting beside it: a
-- member with both an address and a number should get the notice both ways,
-- and one transport being down must not mark the other as already done.
--
-- Dropping and recreating is safe here despite the warning Prisma raises about
-- duplicates. Every existing row is email by the default just applied, so the
-- wider key cannot collide where the narrower one did not.
DROP INDEX "ReminderLog_membershipId_kind_sentOn_key";

CREATE UNIQUE INDEX "ReminderLog_membershipId_kind_channel_sentOn_key"
  ON "ReminderLog"("membershipId", "kind", "channel", "sentOn");
