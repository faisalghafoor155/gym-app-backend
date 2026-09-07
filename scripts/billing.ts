/**
 * The operator's side of subscription billing.
 *
 * Most of billing runs itself — the daily job issues invoices and suspends
 * gyms that have not paid, and a gateway callback settles an invoice and lifts
 * that suspension. This is for the parts that need a person:
 *
 *   npx tsx scripts/billing.ts                        # every gym and where it stands
 *   npx tsx scripts/billing.ts <gymId>                # one gym's invoices in detail
 *   npx tsx scripts/billing.ts <gymId> start basic    # begin billing, issue the first invoice
 *   npx tsx scripts/billing.ts <invoiceId> paid       # money arrived out of band
 *   npx tsx scripts/billing.ts <invoiceId> void "..." # stop asking for it
 *   npx tsx scripts/billing.ts run                    # run the daily sweep now
 *
 * `paid` is the one to be careful with: it settles an invoice with no
 * signature behind it, which is right for a bank transfer somebody has
 * confirmed and wrong for anything else. It records that it was a human who
 * said so — `provider` stays null, which is the honest difference between "the
 * gateway told us" and "somebody says so".
 *
 * Nothing here writes an audit row, matching `setPlan.ts`: the trail records
 * what happens inside a gym, by somebody with a session. This is an operator
 * at a terminal with database credentials, and inventing an actor for them
 * would put a name in the log nobody signed in as.
 */

import 'dotenv/config';
import type { GymPlan } from '@prisma/client';
import prisma from '../src/db.js';
import { PLAN_LABELS } from '../src/services/subscription.js';
import {
  AlreadySettled,
  PLAN_PRICES,
  addDays,
  ensureSubscription,
  isBillable,
  issueInvoiceIfDue,
  settleInvoice,
} from '../src/services/billing.js';
import { runSubscriptionBilling } from '../src/jobs/subscriptionBilling.js';

const day = (d: Date | null): string =>
  d ? d.toISOString().slice(0, 10) : '—';

/** Every gym, its tier, and whether it owes anything. */
const listGyms = async (): Promise<void> => {
  const gyms = await prisma.gym.findMany({
    select: {
      id: true,
      name: true,
      plan: true,
      suspendedAt: true,
      subscription: {
        select: {
          paidThrough: true,
          active: true,
          invoices: {
            where: { status: 'open' },
            select: { amount: true, dueDate: true },
            orderBy: { issuedAt: 'asc' },
            take: 1,
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (gyms.length === 0) {
    console.log('No gyms.');
    return;
  }

  for (const gym of gyms) {
    const sub = gym.subscription;
    const open = sub?.invoices[0];
    const parts = [
      gym.id,
      PLAN_LABELS[gym.plan].padEnd(5),
      sub ? `paid through ${day(sub.paidThrough)}` : 'not billed',
    ];
    if (open) {
      parts.push(
        `OWES Rs. ${open.amount.toString()} (due ${day(open.dueDate)})`,
      );
    }
    if (gym.suspendedAt) parts.push('SUSPENDED');
    console.log(`${gym.name}\n  ${parts.join('  ·  ')}`);
  }
};

/** One gym's billing history, in full. */
const showGym = async (gymId: string): Promise<void> => {
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
    select: {
      name: true,
      plan: true,
      suspendedAt: true,
      suspendedReason: true,
      subscription: {
        include: { invoices: { orderBy: { issuedAt: 'desc' } } },
      },
    },
  });

  if (!gym) {
    console.error(`No gym with id ${gymId}.`);
    process.exitCode = 1;
    return;
  }

  console.log(`${gym.name} — ${PLAN_LABELS[gym.plan]}`);
  if (gym.suspendedAt) {
    console.log(`  SUSPENDED ${day(gym.suspendedAt)}: ${gym.suspendedReason ?? ''}`);
  }

  const sub = gym.subscription;
  if (!sub) {
    console.log('  Not billed. Start with: billing.ts <gymId> start <plan>');
    return;
  }

  console.log(
    `  Rs. ${sub.amount.toString()} every ${sub.periodDays} days, ` +
      `grace ${sub.graceDays} days, paid through ${day(sub.paidThrough)}` +
      (sub.active ? '' : ' (billing stopped)'),
  );

  if (sub.invoices.length === 0) {
    console.log('  No invoices yet.');
    return;
  }

  console.log('\n  Invoices:');
  for (const i of sub.invoices) {
    const settled =
      i.status === 'paid'
        ? `paid ${day(i.paidAt)}${i.provider ? ` via ${i.provider}` : ' by hand'}`
        : i.status;
    console.log(
      `    ${i.id}  Rs. ${i.amount.toString().padStart(8)}  ` +
        `${day(i.periodStart)}→${day(i.periodEnd)}  due ${day(i.dueDate)}  ${settled}` +
        (i.note ? `\n      note: ${i.note}` : ''),
    );
  }
};

/** Begins billing a gym, and issues its first invoice. */
const start = async (gymId: string, plan: GymPlan): Promise<void> => {
  if (!isBillable(plan)) {
    console.error(
      `${PLAN_LABELS[plan]} costs nothing, so there is nothing to bill. ` +
        `Move a gym onto it with setPlan.ts instead.`,
    );
    process.exitCode = 1;
    return;
  }

  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
    select: { name: true },
  });
  if (!gym) {
    console.error(`No gym with id ${gymId}.`);
    process.exitCode = 1;
    return;
  }

  const sub = await ensureSubscription(gymId, plan);
  const invoice = await issueInvoiceIfDue(sub.id, new Date());

  console.log(
    `${gym.name}: billing ${PLAN_LABELS[plan]} at Rs. ${PLAN_PRICES[plan]} ` +
      `every ${sub.periodDays} days.`,
  );
  if (invoice) {
    console.log(
      `  Invoice ${invoice.id} — Rs. ${invoice.amount.toString()}, ` +
        `due ${day(invoice.dueDate)}, covers ${day(invoice.periodStart)}→${day(invoice.periodEnd)}.`,
    );
    console.log(
      `  The gym is NOT on ${PLAN_LABELS[plan]} until this is paid. ` +
        `Suspends ${day(addDays(invoice.dueDate, sub.graceDays))} if it is not.`,
    );
  } else {
    console.log('  Nothing to invoice yet — the current term still has time on it.');
  }
};

/** Settles an invoice whose money arrived outside the app. */
const markPaid = async (invoiceId: string, note?: string): Promise<void> => {
  const invoice = await prisma.subscriptionInvoice.findUnique({
    where: { id: invoiceId },
    select: { status: true, amount: true, gym: { select: { name: true } } },
  });
  if (!invoice) {
    console.error(`No invoice with id ${invoiceId}.`);
    process.exitCode = 1;
    return;
  }
  if (invoice.status !== 'open') {
    console.error(`That invoice is already ${invoice.status}.`);
    process.exitCode = 1;
    return;
  }

  try {
    // No provider: this was not a gateway, and recording one would claim a
    // verification that never happened.
    await settleInvoice(invoiceId, {
      note: note ?? 'Marked paid by an operator',
    });
    console.log(
      `${invoice.gym.name}: invoice ${invoiceId} settled ` +
        `(Rs. ${invoice.amount.toString()}). Term extended; any billing ` +
        `suspension lifted.`,
    );
  } catch (err) {
    if (err instanceof AlreadySettled) {
      console.error('That invoice was settled a moment ago by something else.');
      process.exitCode = 1;
      return;
    }
    throw err;
  }
};

/** Stops asking for an invoice, without deleting the record of it. */
const markVoid = async (invoiceId: string, why: string): Promise<void> => {
  const updated = await prisma.subscriptionInvoice.updateMany({
    where: { id: invoiceId, status: 'open' },
    data: { status: 'void', note: why },
  });
  if (updated.count === 0) {
    console.error('No open invoice with that id.');
    process.exitCode = 1;
    return;
  }
  console.log(`Invoice ${invoiceId} voided: ${why}`);
  console.log(
    '  Note this does not lift a suspension — use suspendGym.ts if the gym ' +
      'should be let back in.',
  );
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const [first, second, third] = args;

  if (!first) {
    await listGyms();
    return;
  }

  if (first === 'run') {
    const run = await runSubscriptionBilling();
    console.log(
      `subscriptions ${run.due}, invoiced ${run.issued}, ` +
        `suspended ${run.suspended}, already suspended ${run.alreadySuspended}, ` +
        `failed ${run.failed}`,
    );
    return;
  }

  if (!second) {
    await showGym(first);
    return;
  }

  if (second === 'start') {
    if (third !== 'basic' && third !== 'pro') {
      console.error('Choose a paid tier: basic or pro.');
      process.exitCode = 1;
      return;
    }
    await start(first, third);
    return;
  }

  if (second === 'paid') {
    await markPaid(first, third);
    return;
  }

  if (second === 'void') {
    if (!third) {
      console.error('Say why: billing.ts <invoiceId> void "reason"');
      process.exitCode = 1;
      return;
    }
    await markVoid(first, third);
    return;
  }

  console.error(`Unknown command "${second}". Try: start, paid, void, run.`);
  process.exitCode = 1;
};

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
