import { beforeEach, describe, expect, it } from 'vitest';

import prisma from '../../src/db.js';
import { addUser, api, makeGym, resetDb } from '../helpers.js';
import {
  OVERDUE_SUSPENSION_REASON,
  addDays,
  ensureSubscription,
  issueInvoiceIfDue,
} from '../../src/services/billing.js';

/**
 * The gym's own subscription, over HTTP.
 *
 * The property this file exists for is the awkward one: a gym suspended for
 * not paying must still be able to reach the page it pays from. Everywhere
 * else in the app a suspended gym is stopped at `auth` with a 403, and that is
 * right — but applied to billing it would mean a gym could never lift its own
 * suspension, which is the manual step this whole feature removes. The
 * exemption is narrow, so the tests check both halves: billing opens, and
 * nothing else does.
 */

beforeEach(resetDb);

/** A gym with an open invoice, optionally overdue and suspended for it. */
const withInvoice = async (opts: { suspended?: boolean } = {}) => {
  const owner = await makeGym({ plan: 'basic' });
  const sub = await ensureSubscription(owner.gymId, 'basic');
  const invoice = await issueInvoiceIfDue(sub.id, new Date());

  if (opts.suspended) {
    await prisma.gym.update({
      where: { id: owner.gymId },
      data: {
        suspendedAt: new Date(),
        suspendedReason: OVERDUE_SUSPENSION_REASON,
      },
    });
  }

  return { ...owner, subscriptionId: sub.id, invoiceId: invoice!.id };
};

describe('who may see billing', () => {
  it('gives an owner their subscription and invoices', async () => {
    const gym = await withInvoice();

    const res = await api().get('/api/billing').set('Cookie', gym.cookie);

    expect(res.status).toBe(200);
    expect(res.body.billing.plan).toBe('basic');
    expect(res.body.billing.openInvoice.id).toBe(gym.invoiceId);
    expect(res.body.plans.length).toBeGreaterThan(0);
  });

  it('refuses staff — what the gym pays is the owner’s business', async () => {
    // Deliberately unlike `GET /subscription`, which staff may read because
    // limits explain why a button is missing. An invoice is money.
    const gym = await withInvoice();
    const staff = await addUser(gym.gymId, { role: 'staff' });

    const res = await api().get('/api/billing').set('Cookie', staff.cookie);

    expect(res.status).toBe(403);
  });

  it('says a gym has no subscription rather than inventing one', async () => {
    const owner = await makeGym({ plan: 'free' });

    const res = await api().get('/api/billing').set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body.billing).toBeNull();
  });
});

describe('a gym suspended for not paying', () => {
  it('can still reach its billing page', async () => {
    // The whole point. Behind the normal suspension gate this is a 403, and
    // the gym could never pay its way back in.
    const gym = await withInvoice({ suspended: true });

    const res = await api().get('/api/billing').set('Cookie', gym.cookie);

    expect(res.status).toBe(200);
    expect(res.body.billing.openInvoice.id).toBe(gym.invoiceId);
  });

  it('can still start a checkout', async () => {
    const gym = await withInvoice({ suspended: true });

    const res = await api()
      .post('/api/billing/checkout')
      .set('Cookie', gym.cookie)
      .send({ provider: 'manual' });

    expect(res.status).toBe(201);
    expect(res.body.amount).toBeGreaterThan(0);
  });

  it('still cannot reach anything else', async () => {
    // The exemption has to be narrow, or "let them pay" becomes "let them
    // carry on". A suspended gym may settle what it owes and nothing more.
    const gym = await withInvoice({ suspended: true });

    for (const path of ['/api/members', '/api/dashboard', '/api/subscription']) {
      const res = await api().get(path).set('Cookie', gym.cookie);
      expect(res.status, `${path} should be refused`).toBe(403);
      expect(res.body.reason).toBe('gym_suspended');
    }
  });
});

describe('starting a subscription', () => {
  it('issues an invoice but does not move the gym onto the tier', async () => {
    // Asking is not paying. A gym moved to Pro by its own request would be a
    // gym with Pro for free.
    const owner = await makeGym({ plan: 'free' });

    const res = await api()
      .post('/api/billing/subscribe')
      .set('Cookie', owner.cookie)
      .send({ plan: 'pro' });

    expect(res.status).toBe(201);
    expect(res.body.invoice.amount).toBeGreaterThan(0);

    const gym = await prisma.gym.findUniqueOrThrow({ where: { id: owner.gymId } });
    expect(gym.plan).toBe('free');
  });

  it('does not issue a second invoice when pressed twice', async () => {
    const owner = await makeGym({ plan: 'free' });

    await api()
      .post('/api/billing/subscribe')
      .set('Cookie', owner.cookie)
      .send({ plan: 'basic' });
    const second = await api()
      .post('/api/billing/subscribe')
      .set('Cookie', owner.cookie)
      .send({ plan: 'basic' });

    expect(second.status).toBe(201);
    expect(
      await prisma.subscriptionInvoice.count({ where: { gymId: owner.gymId } }),
    ).toBe(1);
  });

  it('refuses to change tier mid-term', async () => {
    const gym = await withInvoice();

    const res = await api()
      .post('/api/billing/subscribe')
      .set('Cookie', gym.cookie)
      .send({ plan: 'pro' });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('subscription_exists');
  });

  it('rejects a tier that is not for sale', async () => {
    const owner = await makeGym({ plan: 'free' });

    const res = await api()
      .post('/api/billing/subscribe')
      .set('Cookie', owner.cookie)
      .send({ plan: 'free' });

    expect(res.status).toBe(400);
  });
});

describe('checkout', () => {
  it('takes the amount from the invoice, never the request', async () => {
    // The body has no amount field at all, which is the strongest version of
    // that guarantee: there is nothing to tamper with.
    const gym = await withInvoice();

    const res = await api()
      .post('/api/billing/checkout')
      .set('Cookie', gym.cookie)
      .send({ provider: 'manual', amount: 1 });

    expect(res.status).toBe(201);
    const invoice = await prisma.subscriptionInvoice.findUniqueOrThrow({
      where: { id: gym.invoiceId },
    });
    expect(res.body.amount).toBe(invoice.amount.toNumber());
    expect(res.body.amount).toBeGreaterThan(1);
  });

  it('refuses when there is nothing outstanding', async () => {
    const owner = await makeGym({ plan: 'free' });

    const res = await api()
      .post('/api/billing/checkout')
      .set('Cookie', owner.cookie)
      .send({ provider: 'manual' });

    expect(res.status).toBe(404);
  });

  it('refuses a provider that has no credentials configured', async () => {
    // A gateway missing its secrets cannot verify its own callbacks, so
    // starting a payment through it strands the gym on an invoice nothing can
    // settle. PLATFORM_JAZZCASH_* is unset in the suite.
    const gym = await withInvoice();

    const res = await api()
      .post('/api/billing/checkout')
      .set('Cookie', gym.cookie)
      .send({ provider: 'jazzcash' });

    expect(res.status).toBe(400);
  });

  it('does not settle anything on its own', async () => {
    const gym = await withInvoice();

    await api()
      .post('/api/billing/checkout')
      .set('Cookie', gym.cookie)
      .send({ provider: 'manual' });

    const invoice = await prisma.subscriptionInvoice.findUniqueOrThrow({
      where: { id: gym.invoiceId },
    });
    expect(invoice.status).toBe('open');
    expect(invoice.paidAt).toBeNull();
  });
});

describe('callbacks', () => {
  it('refuses an unsigned body', async () => {
    // The callback is public and unauthenticated, so the signature is the only
    // thing standing between a stranger and a free subscription.
    const gym = await withInvoice();

    const res = await api()
      .post('/api/billing/callback/jazzcash')
      .send({ pp_TxnRefNo: gym.invoiceId, pp_Amount: '100', pp_ResponseCode: '000' });

    expect(res.status).toBe(400);

    const invoice = await prisma.subscriptionInvoice.findUniqueOrThrow({
      where: { id: gym.invoiceId },
    });
    expect(invoice.status).toBe('open');
  });

  it('refuses a callback for the manual provider', async () => {
    // `manual` has no secret, so it can never believe a callback — it is
    // settled by an operator instead.
    const gym = await withInvoice();

    const res = await api()
      .post('/api/billing/callback/manual')
      .send({ orderRefNum: gym.invoiceId });

    expect(res.status).toBe(400);
  });

  it('is reachable without a session', async () => {
    // A provider posts server-to-server and carries no cookie. Behind `auth`
    // every real callback would be rejected and every payment left pending.
    const res = await api().post('/api/billing/callback/easypaisa').send({});

    // Refused for want of a signature — not for want of a session.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid callback');
  });
});

describe('what the owner is shown', () => {
  it('says when access stops if the invoice goes unpaid', async () => {
    const gym = await withInvoice();

    const res = await api().get('/api/billing').set('Cookie', gym.cookie);

    const invoice = await prisma.subscriptionInvoice.findUniqueOrThrow({
      where: { id: gym.invoiceId },
    });
    const sub = await prisma.gymSubscription.findUniqueOrThrow({
      where: { id: gym.subscriptionId },
    });
    expect(new Date(res.body.billing.suspendsOn).getTime()).toBe(
      addDays(invoice.dueDate, sub.graceDays).getTime(),
    );
  });

  it('reports an invoice past its due date as overdue', async () => {
    const gym = await withInvoice();
    await prisma.subscriptionInvoice.update({
      where: { id: gym.invoiceId },
      data: { dueDate: addDays(new Date(), -3) },
    });

    const res = await api().get('/api/billing').set('Cookie', gym.cookie);

    expect(res.body.billing.overdueSince).not.toBeNull();
  });
});
