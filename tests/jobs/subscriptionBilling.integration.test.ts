import { beforeEach, describe, expect, it } from 'vitest';

import prisma from '../../src/db.js';
import { makeGym, resetDb } from '../helpers.js';
import { runSubscriptionBilling } from '../../src/jobs/subscriptionBilling.js';
import {
  AlreadySettled,
  OVERDUE_SUSPENSION_REASON,
  addDays,
  ensureSubscription,
  issueInvoiceIfDue,
  settleInvoice,
} from '../../src/services/billing.js';

/**
 * Billing a gym for its own subscription.
 *
 * Three properties carry the weight here, and the arithmetic is secondary to
 * all of them:
 *
 *   - A gym is never billed twice for one period. The sweep runs daily and may
 *     run twice in a day; double-billing is money taken that was not owed.
 *   - A gym that stops paying is *suspended*, never downgraded. The schema
 *     argues this at length — a downgrade silently takes away members the gym
 *     can still see, with nothing on screen saying why.
 *   - Paying lifts the suspension that non-payment caused, and only that one.
 *     A gym stopped for some other reason must not buy its way back in.
 */

beforeEach(resetDb);

/** A gym with billing started, on a paid tier. */
const billedGym = async (opts: { plan?: 'basic' | 'pro'; graceDays?: number } = {}) => {
  const { plan = 'basic', graceDays } = opts;
  const owner = await makeGym({ plan });
  const sub = await ensureSubscription(owner.gymId, plan, { graceDays });
  return { ...owner, subscriptionId: sub.id };
};

const openInvoices = (gymId: string) =>
  prisma.subscriptionInvoice.findMany({ where: { gymId, status: 'open' } });

const gymRow = (gymId: string) =>
  prisma.gym.findUniqueOrThrow({
    where: { id: gymId },
    select: { plan: true, suspendedAt: true, suspendedReason: true },
  });

describe('issuing invoices', () => {
  it('issues a first invoice for a gym that has just started billing', async () => {
    const gym = await billedGym();

    const run = await runSubscriptionBilling();

    expect(run).toMatchObject({ due: 1, issued: 1, suspended: 0 });
    const open = await openInvoices(gym.gymId);
    expect(open).toHaveLength(1);
    expect(open[0]!.amount.toNumber()).toBeGreaterThan(0);
  });

  it('does not issue a second invoice while one is still open', async () => {
    // The sweep runs daily and may run twice — a retried container, two
    // backend instances. Billing one period twice is money that was not owed.
    const gym = await billedGym();

    await runSubscriptionBilling();
    const second = await runSubscriptionBilling();

    expect(second.issued).toBe(0);
    expect(await openInvoices(gym.gymId)).toHaveLength(1);
  });

  it('does not bill a gym on the free tier', async () => {
    // A zero-rupee invoice is one no gateway can settle, carrying a due date
    // that would eventually suspend a gym that never owed anything.
    const owner = await makeGym({ plan: 'free' });
    await prisma.gymSubscription.create({
      data: { gymId: owner.gymId, plan: 'free', amount: 0 },
    });

    const run = await runSubscriptionBilling();

    expect(run.issued).toBe(0);
    expect(await openInvoices(owner.gymId)).toHaveLength(0);
  });

  it('does not bill a subscription that has been stopped', async () => {
    const gym = await billedGym();
    await prisma.gymSubscription.update({
      where: { id: gym.subscriptionId },
      data: { active: false },
    });

    const run = await runSubscriptionBilling();

    expect(run.issued).toBe(0);
  });

  it('waits until the paid term is nearly up before billing the next one', async () => {
    const gym = await billedGym();
    // Paid well into the future: nothing is owed yet.
    await prisma.gymSubscription.update({
      where: { id: gym.subscriptionId },
      data: { paidThrough: addDays(new Date(), 60) },
    });

    const run = await runSubscriptionBilling();

    expect(run.issued).toBe(0);
  });

  it('starts the next period where the paid one ended, losing no days', async () => {
    const gym = await billedGym();
    const paidThrough = addDays(new Date(), 3);
    await prisma.gymSubscription.update({
      where: { id: gym.subscriptionId },
      data: { paidThrough },
    });

    await runSubscriptionBilling();

    const [invoice] = await openInvoices(gym.gymId);
    expect(invoice!.periodStart.getTime()).toBe(paidThrough.getTime());
  });
});

describe('a gym that has not paid', () => {
  it('leaves it alone while it is still inside the grace period', async () => {
    const gym = await billedGym({ graceDays: 7 });
    await runSubscriptionBilling();
    // Due two days ago, so overdue but well inside seven days of grace.
    await prisma.subscriptionInvoice.updateMany({
      where: { gymId: gym.gymId, status: 'open' },
      data: { dueDate: addDays(new Date(), -2) },
    });

    const run = await runSubscriptionBilling();

    expect(run.suspended).toBe(0);
    expect((await gymRow(gym.gymId)).suspendedAt).toBeNull();
  });

  it('suspends it once the grace period has run out', async () => {
    const gym = await billedGym({ graceDays: 7 });
    await runSubscriptionBilling();
    await prisma.subscriptionInvoice.updateMany({
      where: { gymId: gym.gymId, status: 'open' },
      data: { dueDate: addDays(new Date(), -8) },
    });

    const run = await runSubscriptionBilling();

    expect(run.suspended).toBe(1);
    const row = await gymRow(gym.gymId);
    expect(row.suspendedAt).not.toBeNull();
    expect(row.suspendedReason).toBe(OVERDUE_SUSPENSION_REASON);
  });

  it('suspends rather than downgrading — the tier is untouched', async () => {
    // The property the schema argues for: nothing is taken away, the gym is
    // stopped with an explanation. A downgrade would silently drop it below
    // its own roster with nothing on screen saying why.
    const gym = await billedGym({ plan: 'pro', graceDays: 0 });
    await runSubscriptionBilling();
    await prisma.subscriptionInvoice.updateMany({
      where: { gymId: gym.gymId, status: 'open' },
      data: { dueDate: addDays(new Date(), -1) },
    });

    await runSubscriptionBilling();

    expect((await gymRow(gym.gymId)).plan).toBe('pro');
  });

  it('does not overwrite a suspension an operator made for another reason', async () => {
    const gym = await billedGym({ graceDays: 0 });
    await runSubscriptionBilling();
    await prisma.subscriptionInvoice.updateMany({
      where: { gymId: gym.gymId, status: 'open' },
      data: { dueDate: addDays(new Date(), -1) },
    });
    await prisma.gym.update({
      where: { id: gym.gymId },
      data: { suspendedAt: new Date(), suspendedReason: 'Court order' },
    });

    const run = await runSubscriptionBilling();

    expect(run.suspended).toBe(0);
    expect(run.alreadySuspended).toBe(1);
    expect((await gymRow(gym.gymId)).suspendedReason).toBe('Court order');
  });
});

describe('settling an invoice', () => {
  it('extends the term to the end of the period that was paid for', async () => {
    const gym = await billedGym();
    await runSubscriptionBilling();
    const [invoice] = await openInvoices(gym.gymId);

    await settleInvoice(invoice!.id, { note: 'bank transfer' });

    const sub = await prisma.gymSubscription.findUniqueOrThrow({
      where: { id: gym.subscriptionId },
    });
    expect(sub.paidThrough?.getTime()).toBe(invoice!.periodEnd.getTime());
  });

  it('lifts a suspension that non-payment caused', async () => {
    const gym = await billedGym({ graceDays: 0 });
    await runSubscriptionBilling();
    await prisma.subscriptionInvoice.updateMany({
      where: { gymId: gym.gymId, status: 'open' },
      data: { dueDate: addDays(new Date(), -1) },
    });
    await runSubscriptionBilling();
    expect((await gymRow(gym.gymId)).suspendedAt).not.toBeNull();

    const [invoice] = await openInvoices(gym.gymId);
    await settleInvoice(invoice!.id, { note: 'paid at last' });

    const row = await gymRow(gym.gymId);
    expect(row.suspendedAt).toBeNull();
    expect(row.suspendedReason).toBeNull();
  });

  it('does not lift a suspension made for anything else', async () => {
    // Paying an invoice must not unlock a gym stopped for a different reason —
    // otherwise the billing path becomes a way around every other one.
    const gym = await billedGym();
    await runSubscriptionBilling();
    await prisma.gym.update({
      where: { id: gym.gymId },
      data: { suspendedAt: new Date(), suspendedReason: 'Court order' },
    });

    const [invoice] = await openInvoices(gym.gymId);
    await settleInvoice(invoice!.id, { note: 'paid' });

    const row = await gymRow(gym.gymId);
    expect(row.suspendedAt).not.toBeNull();
    expect(row.suspendedReason).toBe('Court order');
  });

  it('refuses a second settlement of the same invoice', async () => {
    // Two callbacks racing — the provider retrying alongside the browser
    // return. The second must find it already settled rather than extending
    // the term a second time.
    const gym = await billedGym();
    await runSubscriptionBilling();
    const [invoice] = await openInvoices(gym.gymId);

    await settleInvoice(invoice!.id, { note: 'first' });

    await expect(settleInvoice(invoice!.id, { note: 'second' })).rejects.toBeInstanceOf(
      AlreadySettled,
    );
  });

  it('applies the tier the invoice was for', async () => {
    // An upgrade invoiced before it took effect: the gym is only moved when
    // the money arrives, never when it asks.
    const owner = await makeGym({ plan: 'basic' });
    const sub = await ensureSubscription(owner.gymId, 'pro');
    await prisma.gym.update({ where: { id: owner.gymId }, data: { plan: 'basic' } });
    const invoice = await issueInvoiceIfDue(sub.id, new Date());

    await settleInvoice(invoice!.id, { note: 'upgrade paid' });

    expect((await gymRow(owner.gymId)).plan).toBe('pro');
  });

  it('issues the next invoice once the paid term is nearly up', async () => {
    const gym = await billedGym();
    await runSubscriptionBilling();
    const [first] = await openInvoices(gym.gymId);
    await settleInvoice(first!.id, { note: 'paid' });

    // Nothing owed immediately after paying.
    expect(await runSubscriptionBilling()).toMatchObject({ issued: 0 });

    // Wind the term back so it is nearly up, as time passing would.
    await prisma.gymSubscription.update({
      where: { id: gym.subscriptionId },
      data: { paidThrough: addDays(new Date(), 2) },
    });

    const run = await runSubscriptionBilling();

    expect(run.issued).toBe(1);
    const open = await openInvoices(gym.gymId);
    expect(open).toHaveLength(1);
    expect(open[0]!.id).not.toBe(first!.id);
  });
});
