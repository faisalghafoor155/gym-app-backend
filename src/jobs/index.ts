import cron from 'node-cron';
import { runExpiryReminders } from './expiryReminders.js';
import { runFingerprintRetention } from './fingerprintRetention.js';
import { runSubscriptionBilling } from './subscriptionBilling.js';

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
 * When fingerprints past their retention window are deleted.
 *
 * Three in the morning, and deliberately not the reminder's slot: this one
 * deletes rows and touches nobody, so it belongs in the quiet hours rather than
 * competing with the working day. A separate expression from `REMINDER_CRON`
 * because "when do members hear from us" and "when do we delete biometrics"
 * are unrelated decisions that should not have to share an answer.
 */
const RETENTION_SCHEDULE = process.env.FINGERPRINT_RETENTION_CRON ?? '0 3 * * *';

/**
 * When subscriptions are invoiced and overdue gyms are stopped.
 *
 * Four in the morning: like the retention sweep this touches nobody who is
 * awake, and it must not land in the same minute as another job — a gym being
 * suspended while the reminder job is emailing its members is a confusing pair
 * of events to read in a log. Its own expression because "when do we bill" is
 * unrelated to "when do we delete biometrics".
 */
const BILLING_SCHEDULE = process.env.BILLING_CRON ?? '0 4 * * *';

/**
 * Whether this process should run scheduled work at all.
 *
 * Off by default in test, where a background job firing mid-suite would write
 * rows no test asked for. Also worth turning off deliberately: run two backend
 * instances and both will schedule, which the jobs are written to survive but
 * which there is no reason to invite.
 */
const enabled = process.env.RUN_JOBS !== 'false' && process.env.NODE_ENV !== 'test';

/**
 * Schedules one job, or says why it could not.
 *
 * A bad cron expression is loud and non-fatal, and it takes down only the job
 * it belongs to: a typo in one variable should not cost a gym the other job as
 * well. Every run logs its result, including the empty ones — "0 due" is how an
 * operator tells a working job from one that has quietly stopped — and a throw
 * is caught here so a failing job never takes the process with it.
 */
const schedule = (
  name: string,
  envVar: string,
  expression: string,
  run: () => Promise<string>,
): void => {
  if (!cron.validate(expression)) {
    console.error(
      `[jobs] ${envVar} is not a valid cron expression: "${expression}". ` +
      `${name} is disabled.`,
    );
    return;
  }

  cron.schedule(expression, () => {
    void run()
      .then(summary => { console.log(`[jobs] ${name} — ${summary}`); })
      .catch(err => { console.error(`[jobs] ${name} failed:`, err); });
  });

  console.log(`[jobs] ${name} scheduled (${expression})`);
};

export const startJobs = (): void => {
  if (!enabled) return;

  schedule('expiry reminders', 'REMINDER_CRON', SCHEDULE, async () => {
    const run = await runExpiryReminders();
    return (
      `due ${run.due}, sent ${run.sent}, already sent ${run.skippedAlreadySent}, ` +
      `no email ${run.skippedNoEmail}, failed ${run.failed}`
    );
  });

  schedule(
    'fingerprint retention',
    'FINGERPRINT_RETENTION_CRON',
    RETENTION_SCHEDULE,
    async () => {
      const run = await runFingerprintRetention();
      return (
        `due ${run.due}, deleted ${run.deleted}, already gone ${run.alreadyGone} ` +
        `(after ${run.afterDays} days without an active membership)`
      );
    },
  );

  schedule('subscription billing', 'BILLING_CRON', BILLING_SCHEDULE, async () => {
    const run = await runSubscriptionBilling();
    return (
      `subscriptions ${run.due}, invoiced ${run.issued}, suspended ${run.suspended}, ` +
      `already suspended ${run.alreadySuspended}, failed ${run.failed}`
    );
  });
};
