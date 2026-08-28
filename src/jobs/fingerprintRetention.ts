import prisma from '../db.js';
import { LAPSED_AFTER_DAYS, addDays } from '../services/membership.js';

/**
 * Deletes the fingerprints of members who have stopped coming.
 *
 * Cascade already covers the member who is deleted outright, and the desk can
 * remove one enrolment by hand. Neither covers the ordinary case: somebody
 * joined, came for two months, drifted away, and was never deleted because
 * their attendance and payment history is worth keeping. Without this job their
 * template sits in the database for as long as the gym runs — which is not a
 * retention policy, it is an absence of one.
 *
 * Only the template goes. The member row, their attendance, their payments and
 * their member number all stay: those are the gym's own records of a commercial
 * relationship, and deciding when to delete them is a different question with a
 * different answer. This job is narrow on purpose — biometric data earns a
 * shorter life than everything around it, and that is the whole point.
 *
 * A member who comes back simply enrols again at the desk. That is a minute of
 * a receptionist's time, set against a template that would otherwise be kept
 * indefinitely for somebody who left.
 */

/**
 * How long after a member has lapsed their fingerprint is kept.
 *
 * Counted from the point `services/membership.ts` already calls lapsed — an
 * expiry more than `LAPSED_AFTER_DAYS` (60) ago — so the total silence before a
 * template is deleted is that plus this, about five months at the defaults.
 *
 * Built on the existing rule rather than a second date test of its own. A
 * separate "expired more than N days" threshold here would be a second, quietly
 * different definition of a departed member, and the two would drift.
 *
 * Set to 0 to delete as soon as a member lapses. There is deliberately no way
 * to switch the job off through configuration: "keep biometrics forever" is not
 * a setting this should make easy, and a gym that truly wants it can not run
 * scheduled work at all (`RUN_JOBS=false`).
 */
const GRACE_DAYS = Math.max(
  0,
  Number(process.env.FINGERPRINT_RETENTION_GRACE_DAYS ?? 90),
);

/**
 * Total days without an active membership before a fingerprint is deleted.
 *
 * Exported so the manual runner can state the policy without recomputing it
 * from the two halves and risking a different answer.
 */
export const RETENTION_AFTER_DAYS = LAPSED_AFTER_DAYS + GRACE_DAYS;

/** The id recorded as the actor for a deletion nobody performed by hand. */
const SYSTEM_ACTOR_ID = 'system';

export interface RetentionRun {
  /** Enrolments found to be past their retention window. */
  due: number;
  /** Enrolments actually deleted. */
  deleted: number;
  /** Found, but gone by the time this job got to them — deleted at the desk,
   *  or by another instance running the same job. */
  alreadyGone: number;
  /** How many whole days of silence a template needed to qualify on this run. */
  afterDays: number;
}

/** Midnight, the boundary every derived membership status is measured against. */
const startOfDay = (now: Date): Date => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
};

/**
 * What the job needs about one enrolment to decide and to write the log entry.
 *
 * The member's name comes along because the audit row has to stay readable
 * after the enrolment it describes is gone — the same reason `actorName` is
 * copied rather than joined.
 */
export type ExpiredEnrolment = {
  id: string;
  gymId: string;
  memberId: string;
  memberName: string;
  enrolledAt: Date;
};

/**
 * Enrolments belonging to members who lapsed longer ago than the grace window.
 *
 * Expressed as date arithmetic against the membership table for the same reason
 * `memberStatusWhere` is: none of these statuses are stored, because they are
 * functions of today's date. This must agree with `isLapsed` — including its
 * boundary, where lapsing needs *more* than `LAPSED_AFTER_DAYS` to have passed.
 *
 * Three groups qualify, and the third is the one worth stating out loud:
 *
 *   - members whose active membership expired long enough ago,
 *   - members somebody deactivated by hand, whose stored status already says
 *     they are off the roster,
 *   - members holding no active membership at all, measured from the enrolment
 *     itself. Somebody enrolled at the desk who never bought anything, or whose
 *     only membership was cancelled, has no expiry date to count from, and
 *     leaving them out would keep exactly the templates with the least reason
 *     to exist.
 *
 * A member with any live membership is never touched, whatever else is true of
 * them.
 *
 * Exported so `scripts/runRetention.ts` can show what a run would delete
 * without deleting it. A preview that asked the question its own way could
 * disagree with the job, and would be worse than no preview.
 */
export const findExpiredEnrolments = async (
  now: Date,
): Promise<ExpiredEnrolment[]> => {
  const today = startOfDay(now);
  // Lapsed, then the grace window on top. `isLapsed` is strictly greater than
  // LAPSED_AFTER_DAYS, so the cutoff sits one day further back than the sum.
  const cutoff = addDays(today, -(LAPSED_AFTER_DAYS + GRACE_DAYS));

  /** A membership that is live today — the disqualifier for every group. */
  const stillCurrent = {
    memberships: {
      some: {
        status: 'active' as const,
        expiryDate: { gte: today },
      },
    },
  };

  const rows = await prisma.fingerprintTemplate.findMany({
    where: {
      OR: [
        // Expired long enough ago. `status: 'active'` on the membership matches
        // `isLapsed`: a cancelled or suspended one ended for a reason somebody
        // recorded, and is covered by the last arm rather than counted from its
        // own date.
        {
          member: {
            NOT: stillCurrent,
            status: 'active',
            memberships: {
              some: { status: 'active', expiryDate: { lt: cutoff } },
            },
          },
        },
        // Deactivated by hand. Deliberately not guarded by `stillCurrent`:
        // somebody decided this member is off the roster, and that outranks a
        // membership whose dates still look healthy — the same precedence
        // `effectiveMemberStatus` gives a stored `inactive` over the calendar.
        // A member deactivated mid-term is exactly who this should cover.
        { member: { status: { not: 'active' } } },
        // No live membership at all, so there is no expiry to count from. The
        // enrolment's own age stands in — and the test belongs on this arm
        // alone, because the two above have a real date to measure from. A
        // member enrolled last week who has not bought a plan yet is somebody
        // mid-signup, not somebody who left.
        {
          enrolledAt: { lt: cutoff },
          member: {
            NOT: stillCurrent,
            status: 'active',
            memberships: { none: { status: 'active' } },
          },
        },
      ],
    },
    select: {
      id: true,
      gymId: true,
      memberId: true,
      enrolledAt: true,
      member: { select: { name: true } },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    gymId: r.gymId,
    memberId: r.memberId,
    memberName: r.member.name,
    enrolledAt: r.enrolledAt,
  }));
};

/**
 * Records a deletion nobody performed by hand.
 *
 * Not `services/audit.ts`: that takes a request, and there is no request here.
 * The row is written directly with a system actor so the trail reads the same
 * as a deletion made at the desk — a gym asking "where did this member's
 * fingerprint go" gets an answer either way.
 *
 * Never throws, on the same reasoning as `audit`: losing a log line must not
 * stop the deletion it describes. A template that survived because its audit
 * row failed would be exactly the wrong outcome.
 */
const logDeletion = async (
  row: ExpiredEnrolment,
  afterDays: number,
): Promise<void> => {
  try {
    await prisma.auditLog.create({
      data: {
        gymId: row.gymId,
        actorId: SYSTEM_ACTOR_ID,
        actorName: 'Automatic retention',
        actorRole: 'owner',
        action: 'fingerprint.retention',
        entity: 'Member',
        entityId: row.memberId,
        entityLabel: row.memberName,
        // No template, no format — the same rule the enrolment endpoint keeps.
        // What is worth recording is why it went, and when it was taken.
        after: {
          reason: 'retention',
          afterDays,
          enrolledAt: row.enrolledAt.toISOString(),
        },
        reason:
          `Fingerprint deleted automatically: no active membership for more than ` +
          `${afterDays} days.`,
      },
    });
  } catch (err) {
    console.error('[jobs] fingerprint retention: audit failed', row.memberId, err);
  }
};

/**
 * Deletes every enrolment past its retention window.
 *
 * `now` is injected so the job is testable without waiting five months, on the
 * same terms as `runExpiryReminders` beside it.
 *
 * Safe to run more than once, and safe to run from two instances: each deletion
 * is by primary key, and a row already gone is counted rather than raised. That
 * matters for the same reason it does for the reminder job — a restart or a
 * second backend must not turn a finished job into an error.
 *
 * Deliberately not a single `deleteMany`. One statement would be faster and
 * would leave no record of which members were affected, which is the wrong
 * trade for the one kind of data here worth being able to account for
 * afterwards.
 */
export const runFingerprintRetention = async (
  now: Date = new Date(),
): Promise<RetentionRun> => {
  const afterDays = RETENTION_AFTER_DAYS;
  const expired = await findExpiredEnrolments(now);
  const run: RetentionRun = {
    due: expired.length,
    deleted: 0,
    alreadyGone: 0,
    afterDays,
  };

  for (const row of expired) {
    // By id, so a member who re-enrolled between the query above and this
    // delete keeps their new template. The row this job decided about is the
    // row it removes, and a fresh enrolment has a different id.
    const { count } = await prisma.fingerprintTemplate.deleteMany({
      where: { id: row.id },
    });

    if (count === 0) {
      run.alreadyGone++;
      continue;
    }

    run.deleted++;
    await logDeletion(row, afterDays);
  }

  return run;
};
