import type { Request, Response } from 'express';
import { Prisma, type PaymentIntent, type PaymentProvider } from '@prisma/client';
import prisma from '../db.js';
import type { AuthedRequest } from '../types.js';
import { addDays, toView, withPlan } from '../services/membership.js';
import { audit } from '../services/audit.js';
import { availableGateways, getGateway } from '../services/gateways/index.js';
import type { CheckoutBody, ConfirmManualParams, ProviderParams } from '../schemas.js';

/**
 * Online payments.
 *
 * The rule this file exists to enforce: **nothing a member sends can grant
 * them anything.** `checkout` only records that somebody intends to pay and
 * hands them to a provider. A membership is created, and a due is settled,
 * exclusively in `handleCallback` — after a signature signed with a secret the
 * member does not have has been verified, and after the amount in that
 * callback has been checked against the price stored when the intent was made.
 *
 * The previous version of this file flipped payments to `paid` directly from
 * the member's own request, which let any signed-in member grant themselves a
 * free membership.
 */

/** How long a member has to complete a checkout before it must be restarted. */
const INTENT_TTL_MINUTES = 60;

/** Thrown when a racing callback already settled the intent. */
class AlreadySettled extends Error {}

/** Returns active membership plans for online purchase/renewal. */
export const getPlans = async (req: AuthedRequest, res: Response): Promise<void> => {
  try {
    const plans = await prisma.membershipPlan.findMany({
      where: { gymId: req.gymId, isActive: true },
      orderBy: { price: 'asc' },
    });
    res.json(plans);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/** Which providers this deployment can actually take money through. */
export const getProviders = async (_req: AuthedRequest, res: Response): Promise<void> => {
  res.json(
    availableGateways().map((g) => ({
      provider: g.provider,
      label: g.label,
      /** `manual` needs different copy in the UI — it is a request, not a payment. */
      redirects: g.provider !== 'manual',
    })),
  );
};

/**
 * Starts a payment. Grants nothing.
 *
 * Writes a `pending` intent with the price read from the database — never from
 * the request — and returns the form the browser posts to the provider.
 */
export const checkout = async (
  req: AuthedRequest<unknown, unknown, CheckoutBody>,
  res: Response,
): Promise<void> => {
  const { type, planId, paymentId, provider } = req.body;
  const memberId = req.memberId;

  if (!memberId) {
    res.status(403).json({ error: 'Only members can checkout online' });
    return;
  }

  const gateway = getGateway(provider);
  // `isConfigured` is checked as well as existence: a provider named in the
  // enum but missing its secrets cannot verify its own callbacks, so starting
  // a payment through it would strand the member on an intent nothing can
  // ever settle.
  if (!gateway || !gateway.isConfigured()) {
    res.status(400).json({ error: 'Payment provider is not available' });
    return;
  }

  try {
    // The amount is resolved from the gym's own rows. This is the number the
    // callback is later checked against, which is what stops a member paying
    // Rs. 1 for a Rs. 5000 plan.
    let amount: Prisma.Decimal;
    let description: string;
    let planIdForIntent: string | null = null;
    let paymentIdForIntent: string | null = null;

    if (type === 'due') {
      const payment = await prisma.payment.findFirst({
        // `gymId` is part of the lookup, not just `memberId`: a member id from
        // another gym must not resolve here even if it were somehow guessed.
        where: { id: paymentId, memberId, gymId: req.gymId, status: 'due' },
        select: { id: true, amount: true },
      });
      if (!payment) {
        res.status(404).json({ error: 'Due payment record not found' });
        return;
      }
      amount = payment.amount;
      paymentIdForIntent = payment.id;
      description = 'Outstanding dues';
    } else {
      const plan = await prisma.membershipPlan.findFirst({
        where: { id: planId, gymId: req.gymId, isActive: true },
        select: { id: true, name: true, price: true },
      });
      if (!plan) {
        res.status(404).json({ error: 'Membership plan not found' });
        return;
      }
      amount = plan.price;
      planIdForIntent = plan.id;
      description = `Membership: ${plan.name}`;
    }

    if (amount.lessThanOrEqualTo(0)) {
      // A zero-priced plan through a payment gateway would come back as a
      // failed transaction; it has to be handled at the front desk.
      res.status(400).json({ error: 'This item cannot be paid online' });
      return;
    }

    const intent = await prisma.paymentIntent.create({
      data: {
        gymId: req.gymId,
        memberId,
        kind: type,
        planId: planIdForIntent,
        paymentId: paymentIdForIntent,
        amount,
        provider,
        expiresAt: new Date(Date.now() + INTENT_TTL_MINUTES * 60 * 1000),
      },
    });

    const initiated = await gateway.initiate({
      intentId: intent.id,
      amount: amount.toNumber(),
      description,
      returnUrl: `${appBaseUrl()}/api/online-payments/return/${provider}`,
    });

    // Stored now so the callback can find this intent by the provider's own
    // reference, which is all some providers echo back.
    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { providerRef: initiated.providerRef },
    });

    await audit(req, {
      action: 'onlinePayment.initiated',
      entity: 'paymentIntent',
      entityId: intent.id,
      entityLabel: description,
      after: { amount: amount.toNumber(), provider, kind: type },
    });

    res.status(201).json({
      intentId: intent.id,
      provider,
      amount: amount.toNumber(),
      // Empty for `manual`, where the client shows "pay at the front desk"
      // rather than posting anywhere.
      url: initiated.url,
      fields: initiated.fields,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start payment' });
  }
};

/** Where the provider should send the member's browser back to. */
const appBaseUrl = (): string =>
  (process.env.APP_BASE_URL ?? 'http://localhost:5000').replace(/\/+$/, '');

/**
 * The only path that turns an intent into money.
 *
 * Public and unauthenticated — the provider calls it server-to-server and has
 * no session — so every guarantee has to come from the signature and from the
 * stored intent, never from the request context.
 */
export const handleCallback = async (
  req: Request<ProviderParams>,
  res: Response,
): Promise<void> => {
  const provider = req.params.provider as PaymentProvider;
  const gateway = getGateway(provider);
  if (!gateway) {
    res.status(404).json({ error: 'Unknown provider' });
    return;
  }

  // Providers post either form-encoded or JSON depending on the integration,
  // and some append their fields to the query string on the browser return.
  const body = { ...(req.query as Record<string, unknown>), ...(req.body as Record<string, unknown>) };
  const verified = gateway.verifyCallback(body);

  if (!verified.ok) {
    // Logged with the reason, answered without it: telling a caller which
    // check failed is a hint for getting past it next time.
    console.warn('[online-payments] rejected callback', provider, verified.reason);
    res.status(400).json({ error: 'Invalid callback' });
    return;
  }

  try {
    const intent = await prisma.paymentIntent.findUnique({
      where: { provider_providerRef: { provider, providerRef: verified.providerRef } },
    });
    if (!intent) {
      console.warn('[online-payments] callback for unknown intent', provider, verified.providerRef);
      res.status(404).json({ error: 'Unknown transaction' });
      return;
    }

    // Replays are expected, not exceptional: providers retry callbacks they
    // did not get a 200 for, and the member's browser return can arrive
    // alongside the server-to-server post. Answering OK without re-granting is
    // what makes those retries harmless.
    if (intent.status !== 'pending') {
      res.json({ received: true, status: intent.status });
      return;
    }

    if (!verified.paid) {
      await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: {
          status: 'failed',
          failureReason: verified.failureReason ?? 'declined',
          rawCallback: body as Prisma.InputJsonValue,
          settledAt: new Date(),
        },
      });
      await auditSystem(intent, 'onlinePayment.failed', {
        reason: verified.failureReason ?? 'declined',
      });
      res.json({ received: true, status: 'failed' });
      return;
    }

    // The amount check. `verified.amount` is what the provider says was paid;
    // `intent.amount` is what the gym's own price list said it costs. A
    // shortfall is treated as a failure rather than a partial payment: the
    // gym is owed a whole membership fee or none.
    const paid = new Prisma.Decimal(verified.amount);
    if (!paid.equals(intent.amount)) {
      await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: {
          status: 'failed',
          failureReason: `amount mismatch: expected ${intent.amount.toString()}, got ${paid.toString()}`,
          rawCallback: body as Prisma.InputJsonValue,
          settledAt: new Date(),
        },
      });
      await auditSystem(intent, 'onlinePayment.amountMismatch', {
        expected: intent.amount.toNumber(),
        received: paid.toNumber(),
      });
      res.status(400).json({ error: 'Amount mismatch' });
      return;
    }

    // An abandoned attempt completed weeks later would be sold at a price the
    // gym may since have changed, so the window is enforced even though the
    // signature is valid.
    if (intent.expiresAt < new Date()) {
      await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: {
          status: 'expired',
          failureReason: 'completed after the checkout window closed',
          rawCallback: body as Prisma.InputJsonValue,
          settledAt: new Date(),
        },
      });
      await auditSystem(intent, 'onlinePayment.expired', { expiresAt: intent.expiresAt });
      res.status(400).json({ error: 'This checkout has expired' });
      return;
    }

    await settleIntent(intent, body);
    res.json({ received: true, status: 'paid' });
  } catch (err) {
    // The browser's return, or a retried callback, settled it a moment ago.
    // That is a success from the provider's point of view, and answering
    // anything else invites it to retry forever.
    if (err instanceof AlreadySettled) {
      res.json({ received: true, status: 'paid' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Callback processing failed' });
  }
};

/**
 * Turns a verified, paid intent into the rows the gym's books are made of.
 *
 * One transaction, so a membership can never exist without the payment that
 * bought it — the bug the old `due` path had, where the comment claimed a
 * transaction that was not there.
 *
 * The intent's own move to `paid` happens inside that transaction and is
 * conditioned on it still being `pending`, so two callbacks racing each other
 * cannot both pass: the second updates zero rows and rolls back.
 */
const settleIntent = async (
  intent: PaymentIntent,
  body: Record<string, unknown>,
): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    // The guard against a concurrent duplicate. `updateMany` with a status
    // filter returns a count rather than throwing, which is what lets the
    // loser of the race bow out cleanly.
    const claimed = await tx.paymentIntent.updateMany({
      where: { id: intent.id, status: 'pending' },
      data: {
        status: 'paid',
        rawCallback: body as Prisma.InputJsonValue,
        settledAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      throw new AlreadySettled();
    }

    if (intent.kind === 'due' && intent.paymentId) {
      await tx.payment.update({
        where: { id: intent.paymentId },
        data: { status: 'paid', method: 'online', paymentDate: new Date() },
      });
      return;
    }

    if (intent.kind === 'renew' && intent.planId) {
      const plan = await tx.membershipPlan.findUniqueOrThrow({
        where: { id: intent.planId },
        select: { name: true, durationDays: true },
      });

      // A renewal bought while the current term still runs starts when that
      // one ends, so the member gets the days they paid for rather than
      // losing the remainder of the term they are in.
      const current = await tx.membership.findFirst({
        where: { memberId: intent.memberId, status: 'active' },
        orderBy: { expiryDate: 'desc' },
        select: { expiryDate: true },
      });
      const now = new Date();
      const startDate = current && current.expiryDate > now ? current.expiryDate : now;
      const expiryDate = addDays(startDate, plan.durationDays);

      const membership = await tx.membership.create({
        data: {
          gymId: intent.gymId,
          memberId: intent.memberId,
          planId: intent.planId,
          startDate,
          expiryDate,
          pricePaid: intent.amount,
          status: 'active',
        },
      });

      await tx.payment.create({
        data: {
          gymId: intent.gymId,
          memberId: intent.memberId,
          amount: intent.amount,
          status: 'paid',
          method: 'online',
          type: 'membership',
          membershipId: membership.id,
          notes: `Online renewal — ${plan.name} (${intent.provider})`,
        },
      });
    }
  });

  await auditSystem(intent, 'onlinePayment.paid', {
    amount: intent.amount.toNumber(),
    provider: intent.provider,
    kind: intent.kind,
  });
};

/**
 * An audit entry for something no signed-in user did.
 *
 * The normal `audit` helper reads the actor off the request, but a provider's
 * callback arrives with no session, so there is nothing to read. The row is
 * written directly instead.
 *
 * `actorId` points at the member whose checkout this settles — they are who
 * the entry is *about*, and the column is not nullable — while `actorName`
 * says plainly that the gateway is what moved it. Attributing it to the member
 * alone would read as though they marked their own payment paid, which is the
 * exact confusion this whole change exists to remove.
 */
const auditSystem = async (
  intent: PaymentIntent,
  action: string,
  after: unknown,
): Promise<void> => {
  try {
    const account = await prisma.user.findFirst({
      where: { memberId: intent.memberId },
      select: { id: true, name: true },
    });
    // A member without a login still has payments settled; the gym's own id is
    // the only honest fallback for a column that must hold something.
    const actorId = account?.id ?? intent.gymId;

    await prisma.auditLog.create({
      data: {
        gymId: intent.gymId,
        actorId,
        actorName: `${intent.provider} gateway${account ? ` (for ${account.name})` : ''}`,
        actorRole: 'member',
        action,
        entity: 'paymentIntent',
        entityId: intent.id,
        entityLabel: intent.kind === 'due' ? 'Outstanding dues' : 'Membership renewal',
        after: after as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    // Same reasoning as the audit service: losing the trail must never cost
    // the gym the payment.
    console.error('[audit] failed to record', action, intent.id, err);
  }
};

/**
 * Where the provider drops the member's browser after checkout.
 *
 * Deliberately does not decide anything: the browser's return is not proof of
 * payment, so this reads the intent the server-to-server callback already
 * settled and redirects to the portal with that status. If the callback has
 * not landed yet the member sees "pending", which is the truth.
 */
export const handleReturn = async (
  req: Request<ProviderParams>,
  res: Response,
): Promise<void> => {
  const provider = req.params.provider as PaymentProvider;
  const gateway = getGateway(provider);
  const portal = `${(process.env.FRONTEND_BASE_URL ?? appBaseUrl()).replace(/\/+$/, '')}/portal`;

  if (!gateway) {
    res.redirect(`${portal}?payment=unknown`);
    return;
  }

  // The browser's return often carries the same signed fields as the callback.
  // Verifying them lets an honest return settle the intent immediately rather
  // than leaving the member staring at "pending" until the provider's
  // server-to-server post arrives — but it is the same verified path, not a
  // shortcut around it.
  const body = { ...(req.query as Record<string, unknown>), ...(req.body as Record<string, unknown>) };
  const verified = gateway.verifyCallback(body);

  let status = 'pending';
  try {
    if (verified.ok) {
      const intent = await prisma.paymentIntent.findUnique({
        where: { provider_providerRef: { provider, providerRef: verified.providerRef } },
      });
      if (intent) {
        if (
          intent.status === 'pending' &&
          verified.paid &&
          new Prisma.Decimal(verified.amount).equals(intent.amount) &&
          intent.expiresAt >= new Date()
        ) {
          try {
            await settleIntent(intent, body);
            status = 'success';
          } catch (err) {
            // The callback won the race; its result is the authoritative one.
            status = err instanceof AlreadySettled ? 'success' : 'pending';
            if (!(err instanceof AlreadySettled)) console.error(err);
          }
        } else {
          status =
            intent.status === 'paid' ? 'success' : intent.status === 'pending' ? 'pending' : 'failed';
        }
      }
    }
  } catch (err) {
    console.error(err);
  }

  res.redirect(`${portal}?payment=${status}`);
};

/**
 * Staff confirming a `manual` intent — the front desk took the cash.
 *
 * This is the only way an intent settles without a signature, and it is
 * deliberately restricted to `manual`: allowing it for a real provider would
 * hand staff a button that grants memberships the gateway never charged for.
 */
export const confirmManual = async (
  req: AuthedRequest<ConfirmManualParams>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  try {
    const intent = await prisma.paymentIntent.findFirst({
      where: { id, gymId: req.gymId },
    });
    if (!intent) {
      res.status(404).json({ error: 'Payment request not found' });
      return;
    }
    if (intent.provider !== 'manual') {
      res.status(400).json({ error: 'Only front-desk payment requests can be confirmed by hand' });
      return;
    }
    if (intent.status !== 'pending') {
      res.status(409).json({ error: `This request is already ${intent.status}` });
      return;
    }

    await settleIntent(intent, { confirmedBy: req.userId });

    await audit(req, {
      action: 'onlinePayment.confirmedManually',
      entity: 'paymentIntent',
      entityId: intent.id,
      entityLabel: intent.kind === 'due' ? 'Outstanding dues' : 'Membership renewal',
      after: { amount: intent.amount.toNumber(), kind: intent.kind },
    });

    res.json({ success: true });
  } catch (err) {
    if (err instanceof AlreadySettled) {
      res.status(409).json({ error: 'This request was already settled' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Could not confirm payment' });
  }
};

/** A member's own view of what they have started paying for. */
export const myIntents = async (req: AuthedRequest, res: Response): Promise<void> => {
  if (!req.memberId) {
    res.status(403).json({ error: 'Only members have online payments' });
    return;
  }
  try {
    const intents = await prisma.paymentIntent.findMany({
      where: { memberId: req.memberId, gymId: req.gymId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { plan: { select: { name: true } } },
    });
    res.json(
      intents.map((i) => ({
        id: i.id,
        kind: i.kind,
        provider: i.provider,
        status: i.status,
        amount: i.amount.toNumber(),
        planName: i.plan?.name ?? null,
        failureReason: i.failureReason,
        createdAt: i.createdAt,
        settledAt: i.settledAt,
      })),
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/** Staff view: front-desk requests waiting to be confirmed. */
export const pendingManual = async (req: AuthedRequest, res: Response): Promise<void> => {
  try {
    const intents = await prisma.paymentIntent.findMany({
      where: { gymId: req.gymId, provider: 'manual', status: 'pending', expiresAt: { gte: new Date() } },
      orderBy: { createdAt: 'desc' },
      include: {
        member: { select: { name: true, memberNo: true } },
        plan: { select: { name: true } },
      },
    });
    res.json(
      intents.map((i) => ({
        id: i.id,
        kind: i.kind,
        amount: i.amount.toNumber(),
        memberName: i.member.name,
        memberNo: i.member.memberNo,
        planName: i.plan?.name ?? null,
        createdAt: i.createdAt,
      })),
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

/** Exported for the tests that exercise the race between two callbacks. */
export const __testing = { settleIntent, AlreadySettled };
