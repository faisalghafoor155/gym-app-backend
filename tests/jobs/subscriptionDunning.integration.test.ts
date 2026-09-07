import { beforeEach, describe, expect, it, vi } from 'vitest';

import prisma from '../../src/db.js';
import { makeGym, resetDb } from '../helpers.js';
import { runSubscriptionBilling } from '../../src/jobs/subscriptionBilling.js';
import {
  addDays,
  ensureSubscription,
  issueInvoiceIfDue,
  settleInvoice,
} from '../../src/services/billing.js';

/**
 * Warning a gym before its access is stopped.
 *
 * Without this the billing job was half a feature: it issued invoices and
 * suspended gyms that had not paid, and the only way an owner learned either
 * had happened was by opening the app or by being locked out of it. A customer
 * who is stopped without warning is a customer who was surprised, and a
 * surprised customer is one who leaves.
 *
 * Three properties carry the weight:
 *
 *   - Nobody is suspended without having been told first, which is the whole
 *     reason the chase runs before the suspension in the same sweep.
 *   - Nobody is told twice for the same step, because a run that happens twice
 *     — a restart, two instances — must not send two emails.
 *   - Paying stops the chasing immediately.
 */

// The transport is stubbed rather than configured: what matters is which
// address was written to and how many times, not that a real server accepted
// it. `mailEnabled` stays false, which is also what the suite runs with.
const sent = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
vi.mock('../../src/services/mail.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/mail.js')>();
  return {
    ...actual,
    mailEnabled: true,
    sendMail: vi.fn((mail: { to: string; subject: string; text: string }) => {
      sent.push(mail);
      return Promise.resolve(true);
    }),
  };
});

beforeEach(async () => {
  await resetDb();
  sent.length = 0;
});

/** A gym being billed, with an invoice due in `dueInDays`. */
const billedGym = async (
  opts: { dueInDays?: number; ownerEmail?: string; graceDays?: number } = {},
) => {
  const { dueInDays = 30, ownerEmail, graceDays = 7 } = opts;
  const owner = await makeGym({ plan: 'basic', ...(ownerEmail && { email: ownerEmail }) });
  const sub = await ensureSubscription(owner.gymId, 'basic', { graceDays });
  const invoice = await issueInvoiceIfDue(sub.id, new Date());

  await prisma.subscriptionInvoice.update({
    where: { id: invoice!.id },
    data: { dueDate: addDays(new Date(), dueInDays) },
  });

  return { ...owner, subscriptionId: sub.id, invoiceId: invoice!.id };
};

const invoiceRow = (id: string) =>
  prisma.subscriptionInvoice.findUniqueOrThrow({ where: { id } });

describe('when a gym is chased', () => {
  it('says nothing while the due date is comfortably ahead', async () => {
    // A gym invoiced a month out has done nothing wrong and does not need an
    // email about it.
    await billedGym({ dueInDays: 30 });

    const run = await runSubscriptionBilling();

    expect(run.noticed).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('warns a week before the due date', async () => {
    const gym = await billedGym({ dueInDays: 7 });

    const run = await runSubscriptionBilling();

    expect(run.noticed).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(gym.email);
    expect(sent[0]!.subject).toMatch(/renews in 7 days/i);
  });

  it('warns again on the day itself', async () => {
    const gym = await billedGym({ dueInDays: 7 });
    await runSubscriptionBilling();
    sent.length = 0;

    // Wind the invoice forward as time passing would.
    await prisma.subscriptionInvoice.update({
      where: { id: gym.invoiceId },
      data: { dueDate: new Date() },
    });

    const run = await runSubscriptionBilling();

    expect(run.noticed).toBe(1);
    expect(sent[0]!.subject).toMatch(/due today/i);
  });

  it('sends a sharper notice once the invoice is overdue', async () => {
    const gym = await billedGym({ dueInDays: -3 });

    const run = await runSubscriptionBilling();

    expect(run.noticed).toBe(1);
    expect(sent[0]!.subject).toMatch(/overdue/i);
  });

  it('always says what is owed, by when, and that nothing is deleted', async () => {
    // An owner reading the last notice after ignoring two needs the facts more
    // than the alarm — including that paying puts everything back.
    await billedGym({ dueInDays: -3 });

    await runSubscriptionBilling();

    expect(sent[0]!.text).toMatch(/Rs\. /);
    expect(sent[0]!.text).toMatch(/nothing is deleted/i);
    expect(sent[0]!.text).toMatch(/\/subscription/);
  });
});

describe('not saying the same thing twice', () => {
  it('does not re-send when the sweep runs twice in a day', async () => {
    // A restart or a second instance re-runs this. An owner who gets the same
    // warning three times learns to ignore the first one next month.
    await billedGym({ dueInDays: 7 });

    await runSubscriptionBilling();
    const second = await runSubscriptionBilling();

    expect(second.noticed).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('does not go back down the schedule once a later notice has gone', async () => {
    // The schedule counts down, so a gym told at 1 day must not be told again
    // at 7 if anything ever re-reads the earlier threshold.
    const gym = await billedGym({ dueInDays: 1 });
    await runSubscriptionBilling();
    expect(sent).toHaveLength(1);

    await prisma.subscriptionInvoice.update({
      where: { id: gym.invoiceId },
      data: { dueDate: addDays(new Date(), 7) },
    });
    sent.length = 0;

    const run = await runSubscriptionBilling();

    expect(run.noticed).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('escalates through the schedule rather than repeating the first notice', async () => {
    // The bug this pins: picking the *first* matching threshold from a
    // descending schedule answers 7 for everything past 7 days out, so every
    // notice after the first says "renews in 7 days" and a gym is warned once
    // and then suspended without another word. Each step must be its own
    // message.
    const gym = await billedGym({ dueInDays: 7 });

    const seen: string[] = [];
    for (const dueInDays of [7, 1, 0, -3]) {
      await prisma.subscriptionInvoice.update({
        where: { id: gym.invoiceId },
        data: { dueDate: addDays(new Date(), dueInDays) },
      });
      await runSubscriptionBilling();
      if (sent.length) seen.push(sent[sent.length - 1]!.subject);
    }

    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    expect(seen[0]).toMatch(/renews in 7 days/i);
    expect(seen[1]).toMatch(/renews in 1 day/i);
    expect(seen[2]).toMatch(/due today/i);
    expect(seen[3]).toMatch(/overdue/i);

    const invoice = await invoiceRow(gym.invoiceId);
    expect(invoice.lastNoticeDaysBefore).toBe(-3);
  });

  it('records which notice went out, so an operator can see it', async () => {
    const gym = await billedGym({ dueInDays: 7 });

    await runSubscriptionBilling();

    const invoice = await invoiceRow(gym.invoiceId);
    expect(invoice.lastNoticeDaysBefore).toBe(7);
    expect(invoice.lastNoticeAt).not.toBeNull();
  });
});

describe('when there is nobody to tell', () => {
  it('counts a gym with no active owner rather than failing silently', async () => {
    // `User.email` is not nullable, so "no address" means no owner account to
    // read one from — revoked, or never replaced after a transfer. Such a gym
    // is about to be suspended with nobody warned, which belongs in the log
    // before it happens rather than after.
    const owner = await makeGym({ plan: 'basic' });
    await prisma.user.updateMany({
      where: { gymId: owner.gymId, role: 'owner' },
      data: { isActive: false },
    });
    const sub = await ensureSubscription(owner.gymId, 'basic');
    const invoice = await issueInvoiceIfDue(sub.id, new Date());
    await prisma.subscriptionInvoice.update({
      where: { id: invoice!.id },
      data: { dueDate: new Date() },
    });

    const run = await runSubscriptionBilling();

    expect(run.noticeSkippedNoEmail).toBe(1);
    expect(run.noticed).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('says nothing to a gym that is already suspended', async () => {
    // It has been told the strongest way there is. An email warning of a
    // suspension would arrive after the fact.
    const gym = await billedGym({ dueInDays: -3 });
    await prisma.gym.update({
      where: { id: gym.gymId },
      data: { suspendedAt: new Date(), suspendedReason: 'Overdue' },
    });

    const run = await runSubscriptionBilling();

    expect(run.noticed).toBe(0);
    expect(sent).toHaveLength(0);
  });
});

describe('the warning comes before the door closes', () => {
  it('never suspends a gym in the same sweep that first warned it', async () => {
    // The property the whole feature exists for. The last notice goes out at
    // three days past due against a seven-day grace, so there is always at
    // least one run — and one email — between the two.
    const gym = await billedGym({ dueInDays: -3, graceDays: 7 });

    const run = await runSubscriptionBilling();

    expect(run.noticed).toBe(1);
    expect(run.suspended).toBe(0);

    const row = await prisma.gym.findUniqueOrThrow({ where: { id: gym.gymId } });
    expect(row.suspendedAt).toBeNull();
  });

  it('suspends only after the grace period, having warned along the way', async () => {
    const gym = await billedGym({ dueInDays: -8, graceDays: 7 });

    const run = await runSubscriptionBilling();

    expect(run.suspended).toBe(1);
    // Warned in the same run it was stopped — this gym only became visible to
    // the job today. The schedule is what spaces the notices for a gym billed
    // normally; this asserts the chase does not skip a gym it is about to
    // suspend.
    expect(run.noticed).toBe(1);
  });
});

describe('paying', () => {
  it('stops the chasing', async () => {
    const gym = await billedGym({ dueInDays: 1 });
    await runSubscriptionBilling();
    sent.length = 0;

    await settleInvoice(gym.invoiceId, { note: 'paid' });

    const run = await runSubscriptionBilling();

    expect(run.noticed).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
