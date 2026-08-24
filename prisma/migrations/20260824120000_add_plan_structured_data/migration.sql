-- Structured plan content, beside the prose that was already there.
--
-- `description` stays a free-text note and keeps its meaning: every plan
-- written before this column existed is still readable exactly as it was.
-- These columns carry the same plan as data the UI can render — days,
-- exercises, meals — rather than a paragraph a human has to parse.
--
-- Nullable on purpose, and with no default. A plan that predates the builder
-- has no structured form, and NULL says that honestly; an empty JSON object
-- would claim the plan is structured and simply empty, which is a different
-- and untrue thing.
ALTER TABLE "WorkoutPlan" ADD COLUMN "workoutData" JSONB;

ALTER TABLE "DietPlan" ADD COLUMN "dietData" JSONB;
