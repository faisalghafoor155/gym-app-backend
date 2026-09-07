/** @format */

import prisma from "../db.js";
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
 * Two halves, in this order on purpose. Issuing first means a gym whose term
 * ends today is invoiced before anything considers suspending it, so the
 * grace period is counted from an invoice it has actually seen.
 */

export interface BillingRun {
  /** Subscriptions considered. */
  due: number;
  /** Invoices issued this run. */
  issued: number;
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
  const stop = await suspendOverdue(now);

  return {
    due: issue.due,
    issued: issue.issued,
    suspended: stop.suspended,
    alreadySuspended: stop.alreadySuspended,
    failed: issue.failed + stop.failed,
  };
};
