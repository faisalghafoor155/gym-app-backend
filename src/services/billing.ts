/** @format */

import { Prisma, type GymPlan, type PaymentProvider } from "@prisma/client";
import prisma from "../db.js";
import { PLAN_LABELS, PLAN_ORDER } from "./subscription.js";

/**
 * What a gym pays us, and what happens when it stops.
 *
 * The counterpart to `subscription.ts`, and deliberately not part of it. That
 * file answers "what may this gym do", which every gate in the app asks on
 * every request; this one answers "has it paid", which only the billing job
 * and the owner's own settings page ask. Keeping them apart is what stops a
 * missed payment being read as a smaller plan — the schema argues at length
 * that a gym which stops paying should be stopped with an explanation rather
 * than quietly downgraded, and that only holds if the two never share a path.
 */

/**
 * The list price of each tier, in rupees per period.
 *
 * Here rather than in the database for the same reason `ENTITLEMENTS` is: a
 * price is a business decision that changes without a migration. What a gym is
 * *actually* charged is copied onto its `GymSubscription` when billing starts,
 * so editing this table re-prices new subscriptions and never silently
 * re-prices the gyms already on the books.
 *
 * `free` is zero and is never invoiced — see `isBillable`.
 */
export const PLAN_PRICES: Record<GymPlan, number> = {
  free: 0,
  basic: Number(process.env.PLAN_PRICE_BASIC ?? 3000),
  pro: Number(process.env.PLAN_PRICE_PRO ?? 8000),
};

/** How long one paid period runs, unless a gym has been given its own term. */
export const DEFAULT_PERIOD_DAYS = Number(process.env.BILLING_PERIOD_DAYS ?? 30);

/** How long after the due date a gym keeps working before it is suspended. */
export const DEFAULT_GRACE_DAYS = Number(process.env.BILLING_GRACE_DAYS ?? 7);

/** How far ahead of a term ending the next invoice goes out. */
export const ISSUE_AHEAD_DAYS = Number(
  process.env.BILLING_ISSUE_AHEAD_DAYS ?? 7,
);

/** How long an invoice checkout stays payable before it must be restarted. */
export const CHECKOUT_TTL_MINUTES = 60;

/**
 * The reason written onto a gym suspended for non-payment.
 *
 * Exported and compared against rather than merely written, because settling
 * the invoice lifts exactly this suspension and no other — see
 * `settleInvoice`.
 */
export const OVERDUE_SUSPENSION_REASON =
  "Your subscription payment is overdue. Please settle the outstanding " +
  "invoice to restore access — nothing has been deleted.";

/**
 * Whether a tier is one we bill for at all.
 *
 * `free` is not. A free gym owes nothing, so issuing it a zero-rupee invoice
 * would create a row no gateway can settle — providers decline zero-amount
 * transactions — and a due date that would eventually suspend a gym that never
 * owed us anything.
 */
export const isBillable = (plan: GymPlan): boolean => PLAN_PRICES[plan] > 0;

/** Days added to a date, in whole days. */
export const addDays = (from: Date, days: number): Date => {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d;
};

/**
 * The subscription row for a gym, created on first use.
 *
 * Not created at signup: a gym on `free` is never billed, and a billing row
 * for a gym that will never be invoiced is one more thing to keep honest for
 * no reason. It appears the moment the gym is put on a paid tier.
 *
 * The price is captured here rather than read at invoice time, which is what
 * makes a later edit to `PLAN_PRICES` apply to new subscriptions only.
 */
export const ensureSubscription = async (
  gymId: string,
  plan: GymPlan,
  opts: { amount?: number; periodDays?: number; graceDays?: number } = {},
) => {
  const existing = await prisma.gymSubscription.findUnique({ where: { gymId } });
  if (existing) return existing;

  return prisma.gymSubscription.create({
    data: {
      gymId,
      plan,
      amount: new Prisma.Decimal(opts.amount ?? PLAN_PRICES[plan]),
      periodDays: opts.periodDays ?? DEFAULT_PERIOD_DAYS,
      graceDays: opts.graceDays ?? DEFAULT_GRACE_DAYS,
    },
  });
};

/**
 * Issues the next invoice for a subscription, if one is due.
 *
 * Returns the invoice, or `null` when nothing is owed yet. Idempotent on two
 * counts, because the daily sweep may run twice — a retried container, two
 * backend instances — and neither may double-bill:
 *
 *   - An `open` invoice already awaiting payment means there is nothing to
 *     issue; a second would bill one term twice.
 *   - The period starts from `paidThrough`, so a re-issued invoice would have
 *     to cover a period the first one already claimed.
 */
export const issueInvoiceIfDue = async (
  subscriptionId: string,
  now: Date,
  issueBeforeDays = ISSUE_AHEAD_DAYS,
) => {
  const sub = await prisma.gymSubscription.findUnique({
    where: { id: subscriptionId },
  });
  if (!sub || !sub.active || !isBillable(sub.plan)) return null;

  const open = await prisma.subscriptionInvoice.findFirst({
    where: { subscriptionId, status: "open" },
  });
  if (open) return null;

  // Nothing to bill until the paid term is close enough to running out.
  if (sub.paidThrough && addDays(now, issueBeforeDays) < sub.paidThrough) {
    return null;
  }

  // The first period starts now; every later one picks up exactly where the
  // paid term ended, so a gym never loses days it paid for and never gets a
  // gap it did not pay for.
  const periodStart = sub.paidThrough ?? now;
  const periodEnd = addDays(periodStart, sub.periodDays);

  return prisma.subscriptionInvoice.create({
    data: {
      subscriptionId: sub.id,
      gymId: sub.gymId,
      plan: sub.plan,
      amount: sub.amount,
      periodStart,
      periodEnd,
      // Due when the period it covers begins — that is what paying up front
      // means. For a first invoice, and for one issued late, that is now.
      dueDate: periodStart > now ? periodStart : now,
    },
  });
};

/** Thrown when a racing callback already settled the invoice. */
export class AlreadySettled extends Error {}

/**
 * Marks an invoice paid and extends the gym's term — the only path that does.
 *
 * One transaction, so a term can never be extended without the invoice that
 * bought it, nor the reverse. The claim on the invoice is conditioned on it
 * still being `open`, so two callbacks racing each other cannot both pass: the
 * second updates zero rows and rolls back. That is the same guard
 * `settleIntent` uses for member payments, for the same reason.
 *
 * Resuming a gym suspended for non-payment happens here too. A gym stopped for
 * an unpaid invoice has, by paying it, removed the reason it was stopped, and
 * leaving it suspended until somebody noticed would reproduce the exact
 * complaint this feature exists to fix. Only *this* suspension is lifted: the
 * update is conditioned on the reason, so a gym stopped by an operator for
 * anything else keeps that reason and paying an invoice cannot unlock it.
 */
export const settleInvoice = async (
  invoiceId: string,
  settledBy: {
    provider?: PaymentProvider;
    providerRef?: string;
    rawCallback?: Prisma.InputJsonValue;
    note?: string;
  },
  now = new Date(),
): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.subscriptionInvoice.updateMany({
      where: { id: invoiceId, status: "open" },
      data: {
        status: "paid",
        paidAt: now,
        provider: settledBy.provider ?? null,
        providerRef: settledBy.providerRef ?? null,
        rawCallback: settledBy.rawCallback,
        note: settledBy.note,
      },
    });
    if (claimed.count === 0) throw new AlreadySettled();

    const invoice = await tx.subscriptionInvoice.findUniqueOrThrow({
      where: { id: invoiceId },
      select: {
        subscriptionId: true,
        gymId: true,
        plan: true,
        periodEnd: true,
      },
    });

    // The term now runs to the end of the period just paid for. Taken from the
    // invoice rather than computed from today, so paying late does not shorten
    // the term and paying early does not lengthen it.
    await tx.gymSubscription.update({
      where: { id: invoice.subscriptionId },
      data: { paidThrough: invoice.periodEnd, plan: invoice.plan },
    });

    // The tier the gym paid for, applied. Normally already correct; it matters
    // for an upgrade that was invoiced before it took effect.
    await tx.gym.update({
      where: { id: invoice.gymId },
      data: { plan: invoice.plan },
    });

    // Conditioned on the reason, so this lifts only the suspension billing
    // placed. `updateMany` because a filter on a non-unique column needs it,
    // and zero rows is the right outcome for a gym that was never suspended.
    await tx.gym.updateMany({
      where: { id: invoice.gymId, suspendedReason: OVERDUE_SUSPENSION_REASON },
      data: { suspendedAt: null, suspendedReason: null },
    });
  });
};

/**
 * What a gym owner needs to see about their own billing.
 *
 * Returns `null` for a gym that has never been billed — a free one — rather
 * than inventing an empty subscription, so the page can say "you are on the
 * free plan" instead of showing a term that does not exist.
 */
export const billingStatus = async (gymId: string, now = new Date()) => {
  const sub = await prisma.gymSubscription.findUnique({
    where: { gymId },
    include: {
      invoices: {
        orderBy: { issuedAt: "desc" },
        take: 12,
      },
    },
  });
  if (!sub) return null;

  const openInvoice = sub.invoices.find((i) => i.status === "open") ?? null;

  return {
    plan: sub.plan,
    planLabel: PLAN_LABELS[sub.plan],
    amount: sub.amount.toNumber(),
    periodDays: sub.periodDays,
    graceDays: sub.graceDays,
    paidThrough: sub.paidThrough,
    active: sub.active,
    /** When access stops if the open invoice stays unpaid. */
    suspendsOn: openInvoice ? addDays(openInvoice.dueDate, sub.graceDays) : null,
    overdueSince:
      openInvoice && openInvoice.dueDate < now ? openInvoice.dueDate : null,
    openInvoice: openInvoice && {
      id: openInvoice.id,
      amount: openInvoice.amount.toNumber(),
      dueDate: openInvoice.dueDate,
      periodStart: openInvoice.periodStart,
      periodEnd: openInvoice.periodEnd,
    },
    invoices: sub.invoices.map((i) => ({
      id: i.id,
      plan: i.plan,
      planLabel: PLAN_LABELS[i.plan],
      amount: i.amount.toNumber(),
      status: i.status,
      periodStart: i.periodStart,
      periodEnd: i.periodEnd,
      dueDate: i.dueDate,
      issuedAt: i.issuedAt,
      paidAt: i.paidAt,
      provider: i.provider,
      note: i.note,
    })),
  };
};

/** The tiers a gym may buy, with what each costs. */
export const purchasablePlans = () =>
  PLAN_ORDER.filter((p) => isBillable(p)).map((plan) => ({
    plan,
    label: PLAN_LABELS[plan],
    amount: PLAN_PRICES[plan],
    periodDays: DEFAULT_PERIOD_DAYS,
  }));
