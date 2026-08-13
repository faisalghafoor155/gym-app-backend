-- One check-in per member per day.
--
-- Nothing stopped a member being checked in fifty times in an evening. The page
-- greyed out anyone already checked in, but that guard reads a list fetched
-- seconds earlier: a second receptionist, or one stale tab, walked straight
-- past it. Attendance is the number the gym reasons about — how busy last
-- Tuesday was, who has stopped coming — and once the rows are in, a member
-- clicked twice is indistinguishable from one who came twice.
--
-- The controller checks for an existing row and returns it, so this constraint
-- is not the error path in normal use. It is what makes the rule true when two
-- inserts race and both checks pass before either lands. A guard that only
-- holds when nothing happens at once is not a guard.

-- The day a check-in falls on. GENERATED ALWAYS rather than a column the
-- application writes: a stored copy is only as honest as every future insert
-- path, and the one thing this column must never do is disagree with the
-- timestamp it is derived from.
--
-- Cast via timestamp, not timezone-aware: checkedInAt is stored without a zone
-- and the gym's day is its own local day, which is the same boundary the
-- controller uses when it looks for today's row.
ALTER TABLE "Attendance"
  ADD COLUMN "checkedInOn" DATE
  GENERATED ALWAYS AS (("checkedInAt")::date) STORED;

-- Existing duplicates have to go before the constraint can exist. The earliest
-- row of each day survives: it is the one that recorded the member actually
-- arriving, and every later row that day is the double-press it is being kept
-- from becoming.
--
-- This deletes attendance history, which is why it is worth being precise about
-- what it deletes: only rows that share a member and a date with an earlier
-- row. A gym that never double-pressed loses nothing.
DELETE FROM "Attendance" a
USING "Attendance" b
WHERE a."memberId" = b."memberId"
  AND a."checkedInOn" = b."checkedInOn"
  AND (a."checkedInAt" > b."checkedInAt"
       OR (a."checkedInAt" = b."checkedInAt" AND a."id" > b."id"));

-- memberId alone, without gymId: a member belongs to exactly one gym, so the
-- pair is already unique per gym, and including gymId would let the same member
-- have a second row under a different gym id — which is not a state that should
-- be reachable in the first place.
ALTER TABLE "Attendance"
  ADD CONSTRAINT "Attendance_memberId_checkedInOn_key"
  UNIQUE ("memberId", "checkedInOn");
