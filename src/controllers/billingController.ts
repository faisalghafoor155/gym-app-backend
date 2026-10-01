/** @format */

import type { Request, Response } from "express";
import { Prisma, type PaymentProvider } from "@prisma/client";
import prisma from "../db.js";
import type { AuthedRequest } from "../types.js";
import { audit } from "../services/audit.js";
import {
  getPlatformGateway,
  availablePlatformGateways,
} from "../services/gateways/platform.js";
import {
  AlreadySettled,
  CHECKOUT_TTL_MINUTES,
  PLAN_PRICES,
  billingStatus,
  ensureSubscription,
  isBillable,
  issueInvoiceIfDue,
  purchasablePlans,
  settleInvoice,
} from "../services/billing.js";
import type { SubscribeBody, SubscriptionCheckoutBody } from "../schemas.js";
import { PLAN_LABELS, type GymPlan } from "../services/subscription.js";

/**
 * A gym paying us for its subscription.
 *
 * The same rule as `onlinePaymentsController`, and it is the reason both files
 * are shaped the way they are: **nothing the payer sends can grant them
 * anything.** `checkout` records an intent to pay and hands the browser to a
 * provider; the term is extended and the tier applied exclusively in
 * `handleCallback`, after a signature made with a secret the gym does not hold
 * has been verified and the amount checked against the invoice.
 *
 * What differs from that file is who is on each side. There, a member pays
 * their gym through the gym's own merchant account. Here a gym pays us through
 * ours — a different registry, different credentials, and a settlement that
 * touches the gym's plan rather than a membership.
 */

/** Where a provider should send the browser back to. */
const appBaseUrl = (): string =>
  (process.env.APP_BASE_URL ?? "http://localhost:5000").replace(/\/+$/, "");

/**
 * What this gym is paying, what it owes, and its invoice history.
 *
 * Owner-only at the route. Unlike the entitlements endpoint — which every
 * member of staff needs, because it explains why a button is missing — this is
 * money, and what the gym pays is the owner's business.
 */
export const getBilling = async (
  req: AuthedRequest,
  res: Response,
): Promise<void> => {
  try {
    const status = await billingStatus(req.gymId);
    res.json({
      // Null for a gym that has never been billed, which the client reads as
      // "on the free plan" rather than as an error.
      billing: status,
      plans: purchasablePlans(),
      providers: availablePlatformGateways().map((g) => ({
        provider: g.provider,
        label: g.label,
        /** `manual` shows "we will confirm it" rather than posting a form. */
        redirects: g.provider !== "manual",
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * Moving onto a paid tier — or rather, asking to.
 *
 * Grants nothing. It creates the billing row and issues the first invoice; the
 * gym is only actually moved when that invoice is paid, in `settleInvoice`.
 * An owner who could set their own `plan` here would be an owner who can have
 * Pro for free, which is the whole thing this file exists to prevent.
 *
 * A gym already on a paid tier is refused rather than re-subscribed: changing
 * tier mid-term has to reconcile a period already paid for, which is a
 * decision for whoever took the money — `scripts/setPlan.ts` — and not a
 * self-serve one.
 */
export const subscribe = async (
  req: AuthedRequest<unknown, unknown, SubscribeBody>,
  res: Response,
): Promise<void> => {
  const { plan } = req.body;

  try {
    const existing = await prisma.gymSubscription.findUnique({
      where: { gymId: req.gymId },
    });

    if (existing && existing.plan !== plan) {
      res.status(409).json({
        error:
          "This gym already has a subscription. Changing tier mid-term is " +
          "arranged with support, so the period already paid for is not lost.",
        reason: "subscription_exists",
      });
      return;
    }

    const subscription =
      existing ?? (await ensureSubscription(req.gymId, plan));

    // Idempotent: an owner who presses subscribe twice gets the invoice the
    // first press issued rather than a second one for the same period.
    const invoice = await issueInvoiceIfDue(subscription.id, new Date());

    await audit(req, {
      action: "subscription.requested",
      entity: "gymSubscription",
      entityId: subscription.id,
      entityLabel: plan,
      after: { plan, amount: PLAN_PRICES[plan] },
    });

    res.status(201).json({
      subscriptionId: subscription.id,
      plan,
      invoice: invoice && {
        id: invoice.id,
        amount: invoice.amount.toNumber(),
        dueDate: invoice.dueDate,
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not start the subscription" });
  }
};

/**
 * Starts paying the open invoice. Grants nothing.
 *
 * The amount comes off the invoice, never the request, and it is the figure
 * the callback is later checked against — which is what stops a gym paying
 * Rs. 1 for a month of Pro.
 */
export const checkoutInvoice = async (
  req: AuthedRequest<unknown, unknown, SubscriptionCheckoutBody>,
  res: Response,
): Promise<void> => {
  const { provider } = req.body;

  const gateway = getPlatformGateway(provider);
  // Configured as well as known: a provider named in the enum but missing its
  // secrets cannot verify its own callbacks, so starting a payment through it
  // would strand the gym on an invoice nothing can ever settle.
  if (!gateway || !gateway.isConfigured()) {
    res.status(400).json({ error: "Payment provider is not available" });
    return;
  }

  try {
    const invoice = await prisma.subscriptionInvoice.findFirst({
      // `gymId` is part of the lookup, so an invoice belonging to another gym
      // cannot be paid — or even found — from this session.
      where: { gymId: req.gymId, status: "open" },
      orderBy: { issuedAt: "asc" },
    });

    if (!invoice) {
      res.status(404).json({ error: "There is nothing outstanding to pay" });
      return;
    }

    const expiresAt = new Date(Date.now() + CHECKOUT_TTL_MINUTES * 60 * 1000);

    const initiated = await gateway.initiate({
      intentId: invoice.id,
      amount: invoice.amount.toNumber(),
      description: `GymPro ${invoice.plan} subscription`,
      returnUrl: `${appBaseUrl()}/api/billing/return/${provider}`,
    });

    // Stored so the callback can find this invoice by the provider's own
    // reference, which is all some of them echo back.
    await prisma.subscriptionInvoice.update({
      where: { id: invoice.id },
      data: { providerRef: initiated.providerRef, provider, checkoutExpiresAt: expiresAt },
    });

    await audit(req, {
      action: "subscription.checkoutStarted",
      entity: "subscriptionInvoice",
      entityId: invoice.id,
      entityLabel: `${invoice.plan} subscription`,
      after: { amount: invoice.amount.toNumber(), provider },
    });

    res.status(201).json({
      invoiceId: invoice.id,
      provider,
      amount: invoice.amount.toNumber(),
      /** Empty for `manual`, where the client says we will confirm it by hand. */
      url: initiated.url,
      fields: initiated.fields,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not start payment" });
  }
};

/**
 * The only path that turns an invoice into money.
 *
 * Public and unauthenticated — the provider calls it server-to-server and has
 * no session — so every guarantee comes from the signature and the stored
 * invoice, never from the request context.
 */
export const handleCallback = async (
  req: Request<{ provider: string }>,
  res: Response,
): Promise<void> => {
  const provider = req.params.provider as PaymentProvider;
  const gateway = getPlatformGateway(provider);
  if (!gateway) {
    res.status(404).json({ error: "Unknown provider" });
    return;
  }

  const body = {
    ...(req.query as Record<string, unknown>),
    ...(req.body as Record<string, unknown>),
  };
  const verified = gateway.verifyCallback(body);

  if (!verified.ok) {
    // Logged with the reason, answered without it: naming the check that
    // failed is a hint for getting past it next time.
    console.warn("[billing] rejected callback", provider, verified.reason);
    res.status(400).json({ error: "Invalid callback" });
    return;
  }

  try {
    const invoice = await prisma.subscriptionInvoice.findUnique({
      where: {
        provider_providerRef: { provider, providerRef: verified.providerRef },
      },
    });
    if (!invoice) {
      console.warn("[billing] callback for unknown invoice", provider, verified.providerRef);
      res.status(404).json({ error: "Unknown transaction" });
      return;
    }

    // Replays are expected rather than exceptional: providers retry callbacks
    // they did not get a 200 for, and the browser return can arrive alongside
    // the server-to-server post. Answering OK without re-settling is what
    // makes those retries harmless.
    if (invoice.status !== "open") {
      res.json({ received: true, status: invoice.status });
      return;
    }

    if (!verified.paid) {
      await prisma.subscriptionInvoice.update({
        where: { id: invoice.id },
        data: {
          note: verified.failureReason ?? "declined",
          rawCallback: body as Prisma.InputJsonValue,
        },
      });
      // Left `open` rather than failed: the gym still owes this, and a failed
      // card should not clear the debt. It stays payable until it is paid or
      // an operator voids it.
      res.json({ received: true, status: "declined" });
      return;
    }

    // What the provider says was paid, against what the invoice says it costs.
    // A shortfall is refused rather than part-credited: a month of Pro is owed
    // whole or not at all.
    const paid = new Prisma.Decimal(verified.amount);
    if (!paid.equals(invoice.amount)) {
      await prisma.subscriptionInvoice.update({
        where: { id: invoice.id },
        data: {
          note:
            `amount mismatch: expected ${invoice.amount.toString()}, ` +
            `got ${paid.toString()}`,
          rawCallback: body as Prisma.InputJsonValue,
        },
      });
      console.warn("[billing] amount mismatch on invoice", invoice.id);
      res.status(400).json({ error: "Amount mismatch" });
      return;
    }

    // An abandoned checkout completed weeks later would settle at a price we
    // may since have changed, so the window is enforced even though the
    // signature is good. The invoice stays open and payable — only this
    // attempt is stale.
    if (invoice.checkoutExpiresAt && invoice.checkoutExpiresAt < new Date()) {
      res.status(400).json({ error: "This checkout has expired" });
      return;
    }

    await settleInvoice(invoice.id, {
      provider,
      providerRef: verified.providerRef,
      rawCallback: body as Prisma.InputJsonValue,
    });
    await auditSystem(invoice.gymId, invoice.id, "subscription.paid", {
      amount: invoice.amount.toNumber(),
      provider,
      plan: invoice.plan,
    });

    res.json({ received: true, status: "paid" });
  } catch (err) {
    // The browser return, or a retried callback, settled it a moment ago —
    // a success from the provider's point of view, and answering otherwise
    // invites it to retry forever.
    if (err instanceof AlreadySettled) {
      res.json({ received: true, status: "paid" });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Callback processing failed" });
  }
};

/**
 * Where the provider drops the owner's browser after checkout.
 *
 * Decides nothing on its own: the browser's return is not proof of payment, so
 * this reads what the server-to-server callback already settled and redirects
 * with that status. A verified return may settle it directly — the same
 * checked path, not a shortcut around it — so an honest one does not leave the
 * owner staring at "pending".
 */
export const handleReturn = async (
  req: Request<{ provider: string }>,
  res: Response,
): Promise<void> => {
  const provider = req.params.provider as PaymentProvider;
  const gateway = getPlatformGateway(provider);
  const page = `${(process.env.FRONTEND_BASE_URL ?? appBaseUrl()).replace(/\/+$/, "")}/subscription`;

  if (!gateway) {
    res.redirect(`${page}?payment=unknown`);
    return;
  }

  const body = {
    ...(req.query as Record<string, unknown>),
    ...(req.body as Record<string, unknown>),
  };
  const verified = gateway.verifyCallback(body);

  let status = "pending";
  try {
    if (verified.ok) {
      const invoice = await prisma.subscriptionInvoice.findUnique({
        where: {
          provider_providerRef: { provider, providerRef: verified.providerRef },
        },
      });
      if (invoice) {
        if (
          invoice.status === "open" &&
          verified.paid &&
          new Prisma.Decimal(verified.amount).equals(invoice.amount) &&
          (!invoice.checkoutExpiresAt || invoice.checkoutExpiresAt >= new Date())
        ) {
          try {
            await settleInvoice(invoice.id, {
              provider,
              providerRef: verified.providerRef,
              rawCallback: body as Prisma.InputJsonValue,
            });
            await auditSystem(invoice.gymId, invoice.id, "subscription.paid", {
              amount: invoice.amount.toNumber(),
              provider,
              plan: invoice.plan,
            });
            status = "success";
          } catch (err) {
            // The callback won the race; its result is the authoritative one.
            status = err instanceof AlreadySettled ? "success" : "pending";
            if (!(err instanceof AlreadySettled)) console.error(err);
          }
        } else {
          status = invoice.status === "paid" ? "success" : "pending";
        }
      }
    }
  } catch (err) {
    console.error(err);
  }

  res.redirect(`${page}?payment=${status}`);
};

/**
 * An audit entry for something no signed-in user did.
 *
 * The normal helper reads the actor off the request, but a provider's callback
 * arrives with no session. The row is written directly instead, with the gym's
 * own id in `actorId` — the column is not nullable and the gym is who the
 * entry is about — and a name that says plainly the gateway is what moved it.
 */
const auditSystem = async (
  gymId: string,
  invoiceId: string,
  action: string,
  after: unknown,
): Promise<void> => {
  try {
    await prisma.auditLog.create({
      data: {
        gymId,
        actorId: gymId,
        actorName: "subscription gateway",
        actorRole: "owner",
        action,
        entity: "subscriptionInvoice",
        entityId: invoiceId,
        entityLabel: "Subscription invoice",
        after: after as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    // Same reasoning as the audit service: losing the trail must never cost
    // us the payment.
    console.error("[audit] failed to record", action, invoiceId, err);
  }
};

/** Exported for the tests that exercise the race between two callbacks. */
export const __testing = { auditSystem, isBillable };

/**
 * Platform Owner / Super Admin check.
 */
export const isPlatformAdmin = (email?: string): boolean => {
  if (!email) return false;
  const adminEmail = (process.env.PLATFORM_ADMIN_EMAIL ?? "faisalghafoor015@gmail.com")
    .toLowerCase()
    .trim();
  return email.toLowerCase().trim() === adminEmail;
};

/**
 * Returns all gym subscription upgrade requests and all gyms for the Platform Owner.
 */
export const getAdminBillingRequests = async (
  req: AuthedRequest,
  res: Response,
): Promise<void> => {
  if (!isPlatformAdmin(req.userEmail)) {
    res.json({ isMasterAdmin: false, pendingRequests: [], allGyms: [] });
    return;
  }

  try {
    const gyms = await prisma.gym.findMany({
      include: {
        users: {
          where: { role: "owner" },
          select: { name: true, email: true },
        },
        subscription: {
          include: {
            invoices: {
              where: { status: "open" },
              orderBy: { issuedAt: "desc" },
            },
          },
        },
        _count: {
          select: {
            members: { where: { status: "active" } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const pendingRequests = [];
    const allGyms = [];

    for (const g of gyms) {
      const owner = g.users[0];
      allGyms.push({
        id: g.id,
        name: g.name,
        ownerName: owner?.name ?? g.ownerName,
        email: owner?.email ?? "—",
        phone: g.phone,
        plan: g.plan,
        planLabel: PLAN_LABELS[g.plan],
        activeMembers: g._count.members,
      });

      if (g.subscription?.invoices) {
        for (const inv of g.subscription.invoices) {
          pendingRequests.push({
            invoiceId: inv.id,
            gymId: g.id,
            gymName: g.name,
            ownerName: owner?.name ?? g.ownerName,
            email: owner?.email ?? "—",
            phone: g.phone,
            currentPlan: g.plan,
            currentPlanLabel: PLAN_LABELS[g.plan],
            requestedPlan: inv.plan,
            requestedPlanLabel: PLAN_LABELS[inv.plan],
            amount: inv.amount.toNumber(),
            issuedAt: inv.issuedAt,
            dueDate: inv.dueDate,
          });
        }
      }
    }

    res.json({
      isMasterAdmin: true,
      pendingRequests,
      allGyms,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * Approves a gym's subscription request, marking invoice as PAID and activating the plan.
 */
export const approveAdminBillingRequest = async (
  req: AuthedRequest<Record<string, string>, unknown, { invoiceId: string; note?: string }>,
  res: Response,
): Promise<void> => {
  if (!isPlatformAdmin(req.userEmail)) {
    res.status(403).json({ error: "Only the platform owner can approve subscriptions" });
    return;
  }

  const { invoiceId, note } = req.body;
  if (!invoiceId) {
    res.status(400).json({ error: "invoiceId is required" });
    return;
  }

  try {
    await settleInvoice(invoiceId, {
      note: note ?? "Approved & Activated by Platform Owner",
    });
    res.json({ success: true, message: "Subscription approved and plan activated successfully!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not approve subscription" });
  }
};

/**
 * Directly updates any gym's plan (Master override).
 */
export const setAdminGymPlan = async (
  req: AuthedRequest<Record<string, string>, unknown, { gymId: string; plan: GymPlan }>,
  res: Response,
): Promise<void> => {
  if (!isPlatformAdmin(req.userEmail)) {
    res.status(403).json({ error: "Only the platform owner can change plans directly" });
    return;
  }

  const { gymId, plan } = req.body;
  if (!gymId || !plan) {
    res.status(400).json({ error: "gymId and plan are required" });
    return;
  }

  try {
    await prisma.gym.update({
      where: { id: gymId },
      data: { plan },
    });
    const planLabel = PLAN_LABELS[plan as GymPlan] || plan;
    res.json({ success: true, message: `Gym plan updated to ${planLabel}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update gym plan" });
  }
};
