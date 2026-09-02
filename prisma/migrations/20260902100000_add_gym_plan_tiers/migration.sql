-- Turns the gym's subscription tier into something the application can trust.
--
-- `Gym.plan` was a free-text column defaulting to 'free' that nothing anywhere
-- read: no limit consulted it, no feature checked it, and a typo would have
-- been stored happily. Making it an enum is what lets it start deciding
-- anything — a value outside the three tiers can no longer reach the database,
-- so a gating check never has to ask what an unrecognised plan is worth.
--
-- Every gym that already exists is moved to 'pro' rather than kept on 'free'.
-- The column was written at signup and never used, so its current value is not
-- a decision anybody made — treating it as one would retroactively cap gyms
-- that have been running without limits, and a gym would discover its new
-- ceiling by failing to add a member at the front desk. 'pro' is the tier that
-- changes nothing on the day this ships; downgrades are a billing decision,
-- made deliberately and one gym at a time.
CREATE TYPE "GymPlan" AS ENUM ('free', 'basic', 'pro');

-- Dropped before the type change: the old default is the string 'free', which
-- Postgres cannot cast while the column is being rewritten.
ALTER TABLE "Gym" ALTER COLUMN "plan" DROP DEFAULT;

ALTER TABLE "Gym"
  ALTER COLUMN "plan" TYPE "GymPlan"
  USING 'pro'::"GymPlan";

-- New gyms start on the trial tier and are moved up when they pay.
ALTER TABLE "Gym" ALTER COLUMN "plan" SET DEFAULT 'free';
