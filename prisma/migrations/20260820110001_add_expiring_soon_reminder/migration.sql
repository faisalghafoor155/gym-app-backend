-- The early warning, sent a few days before a membership runs out — while
-- renewing is still ahead of the member rather than behind them.
--
-- On its own, apart from the migration that adds the channel it travels with.
-- Postgres will not let a value added to an enum be *used* in the same
-- transaction that added it, and Prisma wraps each migration in one, so a
-- combined file fails the moment anything references this value.
ALTER TYPE "ReminderKind" ADD VALUE IF NOT EXISTS 'membershipExpiringSoon';
