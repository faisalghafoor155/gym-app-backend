import cron from 'node-cron';
import { runExpiryReminders } from './expiryReminders.js';

/**
 * The scheduler, kept apart from the work it schedules.
 *
 * Every job here is a plain function that takes its own `now` and can be called
 * directly; this file only decides when. That split is what lets the reminder
 * job be tested without waiting for nine in the morning, and what keeps the
 * test suite from starting a cron it never asked for.
 */

/**
 * When the daily run happens, in the server's own timezone.
 *
 * Nine in the morning rather than midnight: a member reading "expires today"
 * over breakfast can do something about it that day, and a gym owner watching
 * the log sees the run happen during hours they are awake for. Configurable
 * because a gym that opens at six has a different opinion about early.
 */
const SCHEDULE = process.env.REMINDER_CRON ?? '0 9 * * *';

/**
 * Whether this process should run scheduled work at all.
 *
 * Off by default in test, where a background job firing mid-suite would write
 * rows no test asked for. Also worth turning off deliberately: run two backend
 * instances and both will schedule, which the jobs are written to survive but
 * which there is no reason to invite.
 */
const enabled = process.env.RUN_JOBS !== 'false' && process.env.NODE_ENV !== 'test';

export const startJobs = (): void => {
  if (!enabled) return;

  if (!cron.validate(SCHEDULE)) {
    // Loud, and non-fatal. A gym with a typo in REMINDER_CRON should still get
    // an app that serves requests — just without reminders, and with a line in
    // the log saying exactly why.
    console.error(
      `[jobs] REMINDER_CRON is not a valid cron expression: "${SCHEDULE}". ` +
      `Expiry reminders are disabled.`,
    );
    return;
  }

  cron.schedule(SCHEDULE, () => {
    void runExpiryReminders()
      .then(run => {
        // Logged every run, including the empty ones: "0 due" is how an
        // operator tells a working job from one that has quietly stopped.
        console.log(
          `[jobs] expiry reminders — due ${run.due}, sent ${run.sent}, ` +
          `already sent ${run.skippedAlreadySent}, no email ${run.skippedNoEmail}, ` +
          `failed ${run.failed}`,
        );
      })
      // A job that throws must not take the process with it. Tomorrow's run is
      // unaffected, and the trace is what tells an operator why today's is
      // missing.
      .catch(err => { console.error('[jobs] expiry reminders failed:', err); });
  });

  console.log(`[jobs] expiry reminders scheduled (${SCHEDULE})`);
};
