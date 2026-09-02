-- Turns the gym's subscription tier into something the application can trust.
--
-- `Gym.plan` was a free-text column defaulting to 'free' that nothing anywhere
-- read: no limit consulted it, no feature checked it, and a typo would have
-- been stored happily. Making it an enum is what lets it start deciding
-- anything — a value outside the three tiers can no longer reach the database,
-- so a gating check never has to ask what an unrecognised plan is worth.
--
-- Every gym that already exists is moved to 'basic', not left on 'free'.
--
-- Its current value is not a decision anybody made: the column was written at
-- signup and never read, so every row says 'free' by accident rather than
-- because somebody chose it. Honouring that would cap gyms that have been
-- running without limits at 50 members and two staff, and they would find out
-- at the front desk.
--
-- 'basic' is the tier that matches what the app already did. Its six staff
-- seats are exactly the figure that used to be hardcoded for every gym, and
-- the two features it withholds — biometrics and online payments — are not
-- reachable today anyway: no fingerprint driver is registered, and no gateway
-- is configured, so nothing a gym is currently doing stops working.
--
-- The one thing it does not cover is size. A gym already past 300 active
-- members or six staff accounts keeps everything it has — this caps additions,
-- never existing rows — but cannot add the next one until somebody moves it up.
-- `npm run plan` lists every gym against its ceiling, which is the check to run
-- before deploying this, and moving one gym up is a single command.
CREATE TYPE "GymPlan" AS ENUM ('free', 'basic', 'pro');

-- Dropped before the type change: the old default is the string 'free', which
-- Postgres cannot cast while the column is being rewritten.
ALTER TABLE "Gym" ALTER COLUMN "plan" DROP DEFAULT;

ALTER TABLE "Gym"
  ALTER COLUMN "plan" TYPE "GymPlan"
  USING 'basic'::"GymPlan";

-- New gyms start on the trial tier and are moved up when they pay.
ALTER TABLE "Gym" ALTER COLUMN "plan" SET DEFAULT 'free';
