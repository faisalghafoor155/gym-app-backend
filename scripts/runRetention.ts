/**
 * Runs the fingerprint retention job by hand.
 *
 * The job itself is scheduled for 03:00 and needs no help. This exists for the
 * two moments where waiting for 03:00 is not an option: checking what the
 * policy will do to a real roster before it does it, and testing the feature
 * without editing a cron expression and restarting the server.
 *
 *   npx tsx scripts/runRetention.ts            # show what would be deleted
 *   npx tsx scripts/runRetention.ts --delete   # actually delete
 *
 * Previewing is the default, and deleting takes a flag. The wrong way round
 * would mean a script run out of curiosity destroys biometric enrolments that
 * cannot be recovered — every affected member would have to be re-enrolled at
 * the desk. A preview that surprises you is free; a deletion that surprises you
 * is not.
 *
 * The preview asks the job the same question the job asks itself, through the
 * same exported helper, so what it lists is what a real run would take. It is
 * not a separate implementation that could disagree.
 */

import 'dotenv/config';
import prisma from '../src/db.js';
import {
  RETENTION_AFTER_DAYS,
  findExpiredEnrolments,
  runFingerprintRetention,
} from '../src/jobs/fingerprintRetention.js';
import { biometricKeyStatus } from '../src/services/fingerprint/crypto.js';

const confirmed = process.argv.includes('--delete');

const main = async (): Promise<void> => {
  // The job does not decrypt anything, so a missing key would not stop it —
  // but a server that cannot boot is a server whose retention never runs, and
  // finding that out here is better than finding it out from an empty table.
  const key = biometricKeyStatus();
  if (!key.ok) {
    console.warn(`⚠ ${key.error}`);
    console.warn('  The job below does not need the key, but the server will not start without it.\n');
  }

  console.log(
    `Fingerprints are deleted once a member has had no active membership for ` +
    `more than ${RETENTION_AFTER_DAYS} days.\n`,
  );

  const due = await findExpiredEnrolments(new Date());

  if (due.length === 0) {
    const total = await prisma.fingerprintTemplate.count();
    console.log(
      total === 0
        ? 'Nothing to do — no fingerprints are enrolled at all.'
        : `Nothing to do — all ${total} enrolled fingerprints belong to members still on the roster.`,
    );
    return;
  }

  console.log(`${due.length} enrolment${due.length === 1 ? '' : 's'} past the retention window:\n`);
  for (const row of due) {
    console.log(`  ${row.memberName}  (enrolled ${row.enrolledAt.toISOString().slice(0, 10)})`);
  }
  console.log();

  if (!confirmed) {
    console.log('Nothing was deleted. Re-run with --delete to remove them:');
    console.log('  npx tsx scripts/runRetention.ts --delete\n');
    console.log('Members whose fingerprint is deleted enrol again at the desk;');
    console.log('their attendance, payments and membership history are untouched.\n');
    return;
  }

  const run = await runFingerprintRetention();
  console.log(
    `✔ Deleted ${run.deleted}` +
    (run.alreadyGone ? `, ${run.alreadyGone} already gone` : '') +
    `. ${await prisma.fingerprintTemplate.count()} enrolment(s) remain.`,
  );
  console.log('  Each deletion is recorded in the audit log as fingerprint.retention.\n');
};

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
