/** @format */

import prisma from "../db.js";
import { mailEnabled, sendMail, subscriptionInvoiceMail } from "../services/mail.js";
import {
  OVERDUE_SUSPENSION_REASON,
  addDays,
  issueInvoiceIfDue,
} from "../services/billing.js";

/**
 * The daily billing sweep: issue what is due, stop what has not been paid.
 *
 * Written the same way the other jobs are — a plain function taking its own
 * `now`, so it can be tested without waiting for four in the morning, and so
 * the suite never starts a cron it did not ask for. `jobs/index.ts` decides
 * when; this decides what.
 *
 * Three passes, in this order on purpose. Issuing first means a gym whose term
 * ends today is invoiced before anything considers suspending it, so the grace
 * period is counted from an invoice it has actually seen. Chasing sits in the
 * middle, so an owner is warned — repeatedly, and with the date — before the
 * last pass stops them.
 */

export interface BillingRun {
  /** Subscriptions considered. */
  due: number;
  /** Invoices issued this run. */
  issued: number;
  /** Owners emailed about an invoice coming due or already overdue. */
  noticed: number;
  /** Invoices whose gym has no reachable owner — about to be suspended with
   *  nobody warned, which is worth seeing in the log before it happens. */
  noticeSkippedNoEmail: number;
  /** Gyms suspended for an invoice past its due date plus grace. */
  suspended: number;
  /** Gyms already suspended, so left alone. */
  alreadySuspended: number;
  /** Subscriptions that threw; the run continues past them. */
  failed: number;
}

/**
 * Issues invoices for every active subscription that needs one.
 *
 * Each subscription is handled in its own try, so one gym with a broken row
 * does not cost every gym after it its invoice — the same reason the reminder
 * job isolates each member.
 */
const issueDue = async (now: Date): Promise<{ due: number; issued: number; failed: number }> => {
  const subs = await prisma.gymSubscription.findMany({
    where: { active: true },
    select: { id: true, gymId: true },
  });

  let issued = 0;
  let failed = 0;

  for (const sub of subs) {
    try {
      const invoice = await issueInvoiceIfDue(sub.id, now);
      if (invoice) issued += 1;
    } catch (err) {
      failed += 1;
      console.error("[billing] could not issue invoice for", sub.gymId, err);
    }
  }

  return { due: subs.length, issued, failed };
};

/**
 * When a gym is chased about an unpaid invoice, as days before the due date.
 *
 * Descending, and read in order: the first entry whose threshold today has
 * reached is the notice that goes out. A negative number is days *after* the
 * due date, which is where the last warning sits — close enough to suspension
 * that it is the one an owner acts on, far enough that acting still works.
 *
 * Four notices and no more. A gym that has ignored a week of warnings is not
 * going to be moved by a fifth email, and the suspension itself is the message
 * at that point. Configurable as a whole rather than per entry: how hard to
 * chase a customer is a business decision, not a schedule.
 */
const NOTICE_SCHEDULE: readonly number[] = (process.env.BILLING_NOTICE_DAYS ?? '7,1,0,-3')
  .split(',')
  .map((d) => Number(d.trim()))
  .filter((d) => Number.isFinite(d))
  .sort((a, b) => b - a);

/** Whole days from `now` until `date`, counting a part-day as its own day. */
const daysUntil = (now: Date, date: Date): number => {
  const a = new Date(now); a.setHours(0, 0, 0, 0);
  const b = new Date(date); b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
};

/**
 * Which notice is due for an invoice today, or null when none is.
 *
 * The schedule only ever counts down, so a smaller number is always the later
 * notice — which is what lets one column on the invoice record where the
 * chasing has got to. An invoice already told at 1 day is not told again at 7
 * even if the run somehow happens twice.
 */
const noticeDueFor = (
  invoice: { dueDate: Date; lastNoticeDaysBefore: number | null },
  now: Date,
): number | null => {
  const remaining = daysUntil(now, invoice.dueDate);
  // The *most urgent* threshold today has reached, not the first one in the
  // list. `find` over a descending schedule would answer 7 for an invoice
  // three days overdue — every notice after the first would say "renews in 7
  // days", and a gym would be warned once and then suspended without another
  // word. `filter().at(-1)` takes the smallest threshold still satisfied,
  // which is the notice actually due.
  const reached = NOTICE_SCHEDULE.filter((threshold) => remaining <= threshold);
  const due = reached.at(-1);
  if (due === undefined) return null;
  // Already sent this one, or one later in the schedule.
  if (invoice.lastNoticeDaysBefore !== null && invoice.lastNoticeDaysBefore <= due) {
    return null;
  }
  return due;
};

/**
 * Tells gym owners about invoices that are coming due or already overdue.
 *
 * Runs before the suspension pass, so a gym is never suspended in the same
 * sweep that first warned it — the last notice goes out at three days past
 * due, and the default grace is seven.
 *
 * Each notice is claimed by writing it onto the invoice *before* the send, on
 * the same reasoning `expiryReminders` claims a `ReminderLog` row: two
 * instances racing must produce one email, and the loser must find out here
 * rather than after the owner has two copies. A send that then fails gives the
 * claim back so tomorrow tries again — unless mail is not configured at all,
 * where keeping it stops the same notice printing to the log for ever.
 */
const chaseUnpaid = async (
  now: Date,
): Promise<{ noticed: number; skippedNoEmail: number; failed: number }> => {
  let noticed = 0;
  let skippedNoEmail = 0;
  let failed = 0;

  if (NOTICE_SCHEDULE.length === 0) return { noticed, skippedNoEmail, failed };

  const open = await prisma.subscriptionInvoice.findMany({
    where: { status: 'open' },
    select: {
      id: true,
      gymId: true,
      amount: true,
      dueDate: true,
      lastNoticeDaysBefore: true,
      subscription: { select: { graceDays: true } },
      gym: {
        select: {
          name: true,
          // Only unsuspended gyms are chased: one already stopped has been
          // told the strongest way there is, and an email saying "pay to avoid
          // suspension" would arrive after the fact.
          suspendedAt: true,
          users: {
            where: { role: 'owner', isActive: true },
            select: { name: true, email: true },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
        },
      },
    },
  });

  for (const invoice of open) {
    if (invoice.gym.suspendedAt) continue;

    const due = noticeDueFor(invoice, now);
    if (due === null) continue;

    const owner = invoice.gym.users[0];
    if (!owner?.email) {
      // Nobody to tell. Counted rather than silent: a gym billed with no
      // reachable owner is a gym about to be suspended without warning, and
      // that should be visible in the log before it happens.
      skippedNoEmail += 1;
      continue;
    }

    // Claimed before the send. `updateMany` with the previous value in the
    // filter makes it a compare-and-set, so two instances racing cannot both
    // pass — the loser updates zero rows.
    const claimed = await prisma.subscriptionInvoice.updateMany({
      where: { id: invoice.id, lastNoticeDaysBefore: invoice.lastNoticeDaysBefore },
      data: { lastNoticeDaysBefore: due, lastNoticeAt: now },
    });
    if (claimed.count === 0) continue;

    const sent = await sendMail({
      to: owner.email,
      ...subscriptionInvoiceMail(
        invoice.gym.name,
        owner.name,
        invoice.amount.toNumber(),
        invoice.dueDate,
        due,
        addDays(invoice.dueDate, invoice.subscription.graceDays),
        `${(process.env.APP_URL ?? 'http://localhost:8080').replace(/\/+$/, '')}/subscription`,
      ),
    });

    if (sent) {
      noticed += 1;
      continue;
    }

    failed += 1;
    // Given back so tomorrow's run tries again — one unreachable mail server
    // must not silently cost a gym its only warning before suspension. Not
    // when mail is unconfigured, where `sendMail` logs and returns false every
    // time and releasing would reprint the same notice on every run.
    if (mailEnabled) {
      await prisma.subscriptionInvoice.updateMany({
        where: { id: invoice.id, lastNoticeDaysBefore: due },
        data: {
          lastNoticeDaysBefore: invoice.lastNoticeDaysBefore,
          lastNoticeAt: null,
        },
      });
    }
  }

  return { noticed, skippedNoEmail, failed };
};

/**
 * Suspends gyms whose invoice is past its due date plus the grace period.
 *
 * Suspension rather than a downgrade, which is what the schema argues for at
 * length: a gym that stops paying keeps everything it has and is stopped with
 * an explanation, so nothing is lost and resuming puts it back exactly where
 * it was. A silent downgrade would take away members it can still see, with
 * nothing on screen saying why.
 *
 * A gym already suspended is left alone — including one suspended by an
 * operator for some other reason, whose reason must not be overwritten by this
 * one. `suspendedAt: null` in the filter is what guarantees that.
 */
const suspendOverdue = async (
  now: Date,
): Promise<{ suspended: number; alreadySuspended: number; failed: number }> => {
  const overdue = await prisma.subscriptionInvoice.findMany({
    where: { status: "open", dueDate: { lt: now } },
    select: {
      id: true,
      gymId: true,
      dueDate: true,
      subscription: { select: { graceDays: true } },
      gym: { select: { suspendedAt: true } },
    },
  });

  let suspended = 0;
  let alreadySuspended = 0;
  let failed = 0;

  for (const invoice of overdue) {
    // Grace is per subscription: an account a human is already chasing should
    // not be cut off at the same hour as one that has simply vanished.
    if (addDays(invoice.dueDate, invoice.subscription.graceDays) > now) continue;

    if (invoice.gym.suspendedAt) {
      alreadySuspended += 1;
      continue;
    }

    try {
      // Conditioned on the gym still being unsuspended, so an operator who
      // suspended it between the read above and this write keeps their reason
      // rather than having it replaced by ours.
      const stopped = await prisma.gym.updateMany({
        where: { id: invoice.gymId, suspendedAt: null },
        data: { suspendedAt: now, suspendedReason: OVERDUE_SUSPENSION_REASON },
      });
      if (stopped.count > 0) {
        suspended += 1;
        console.warn(
          `[billing] suspended gym ${invoice.gymId} — invoice ${invoice.id} ` +
            `overdue since ${invoice.dueDate.toISOString()}`,
        );
      } else {
        alreadySuspended += 1;
      }
    } catch (err) {
      failed += 1;
      console.error("[billing] could not suspend", invoice.gymId, err);
    }
  }

  return { suspended, alreadySuspended, failed };
};

export const runSubscriptionBilling = async (
  now = new Date(),
): Promise<BillingRun> => {
  const issue = await issueDue(now);
  // Between issuing and suspending on purpose. A gym invoiced a moment ago is
  // chased in the same run, and the last notice goes out three days past due
  // against a seven-day grace — so nothing is ever suspended in the same sweep
  // that first warned it.
  const chase = await chaseUnpaid(now);
  const stop = await suspendOverdue(now);

  return {
    due: issue.due,
    issued: issue.issued,
    noticed: chase.noticed,
    noticeSkippedNoEmail: chase.skippedNoEmail,
    suspended: stop.suspended,
    alreadySuspended: stop.alreadySuspended,
    failed: issue.failed + chase.failed + stop.failed,
  };
};
