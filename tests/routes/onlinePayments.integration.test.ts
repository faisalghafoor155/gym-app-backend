import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import prisma from '../../src/db.js';
import { addMember, addPlan, addUser, api, makeGym, resetDb } from '../helpers.js';
import { hmacSha256Hex, sortedConcat } from '../../src/services/gateways/crypto.js';

/**
 * The property every case here defends: **a member cannot grant themselves
 * anything.** Starting a checkout must leave the books untouched, and only a
 * callback carrying a signature made with the integrity salt — which the
 * member does not have — may create a membership or settle a due.
 *
 * The suite previously asserted the opposite by accident: it checked that
 * POSTing `/checkout` marked a payment `paid`, which was the bug.
 */

const SALT = 'test-integrity-salt';

beforeAll(() => {
  process.env.JAZZCASH_MERCHANT_ID = 'TESTMERCHANT';
  process.env.JAZZCASH_PASSWORD = 'testpassword';
  process.env.JAZZCASH_INTEGRITY_SALT = SALT;
  process.env.JAZZCASH_POST_URL = 'https://sandbox.example/checkout';
});

beforeEach(resetDb);

/** A member with a login, in a gym with a plan to sell. */
const setup = async () => {
  const owner = await makeGym();
  const member = await addMember(owner.gymId);
  const account = await addUser(owner.gymId, { role: 'member', memberId: member.id });
  const plan = await addPlan(owner.gymId, { price: 3000, durationDays: 30 });
  return { owner, member, account, plan };
};

/** Builds a callback body signed exactly the way JazzCash signs one. */
const signedCallback = (fields: Record<string, string>): Record<string, string> => {
  const body = { ...fields };
  body.pp_SecureHash = hmacSha256Hex(SALT, `${SALT}&${sortedConcat(body)}`);
  return body;
};

const startCheckout = async (cookie: string, payload: Record<string, unknown>) =>
  api().post('/api/online-payments/checkout').set('Cookie', cookie).send(payload);

describe('Online payments — checkout grants nothing', () => {
  it('creates only a pending intent when a member starts a renewal', async () => {
    const { account, member, plan } = await setup();

    const res = await startCheckout(account.cookie, {
      type: 'renew',
      planId: plan.id,
      provider: 'jazzcash',
    });

    expect(res.status).toBe(201);
    expect(res.body.intentId).toBeTruthy();
    // The form the browser posts to the provider, not a granted membership.
    expect(res.body.url).toContain('sandbox.example');
    expect(res.body.fields.pp_SecureHash).toBeTruthy();

    // The books are untouched: this is the regression that matters.
    expect(await prisma.membership.count({ where: { memberId: member.id } })).toBe(0);
    expect(await prisma.payment.count({ where: { memberId: member.id } })).toBe(0);

    const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { memberId: member.id } });
    expect(intent.status).toBe('pending');
    expect(intent.amount.toNumber()).toBe(3000);
  });

  it('leaves a due unpaid when a member starts paying it', async () => {
    const { owner, member, account } = await setup();
    const due = await prisma.payment.create({
      data: { gymId: owner.gymId, memberId: member.id, amount: 1500, status: 'due', method: 'cash' },
    });

    const res = await startCheckout(account.cookie, {
      type: 'due',
      paymentId: due.id,
      provider: 'jazzcash',
    });
    expect(res.status).toBe(201);

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: due.id } });
    expect(after.status).toBe('due');
  });

  it('prices the intent from the gym\'s plan, not from the request', async () => {
    const { account, plan, member } = await setup();

    // A member naming their own price must not be believed.
    await startCheckout(account.cookie, {
      type: 'renew',
      planId: plan.id,
      provider: 'jazzcash',
      amount: 1,
      price: 1,
    });

    const intent = await prisma.paymentIntent.findFirstOrThrow({ where: { memberId: member.id } });
    expect(intent.amount.toNumber()).toBe(3000);
  });

  it('refuses a plan belonging to another gym', async () => {
    const { account } = await setup();
    const other = await makeGym({ gymName: 'Other Gym' });
    const otherPlan = await addPlan(other.gymId, { price: 100 });

    const res = await startCheckout(account.cookie, {
      type: 'renew',
      planId: otherPlan.id,
      provider: 'jazzcash',
    });
    expect(res.status).toBe(404);
  });

  it('refuses a due belonging to another member', async () => {
    const { owner, account } = await setup();
    const victim = await addMember(owner.gymId, { name: 'Someone Else' });
    const theirDue = await prisma.payment.create({
      data: { gymId: owner.gymId, memberId: victim.id, amount: 5000, status: 'due', method: 'cash' },
    });

    const res = await startCheckout(account.cookie, {
      type: 'due',
      paymentId: theirDue.id,
      provider: 'jazzcash',
    });
    expect(res.status).toBe(404);
  });

  it('refuses staff, who have no member record to buy for', async () => {
    const { owner, plan } = await setup();
    const staff = await addUser(owner.gymId, { role: 'staff' });

    const res = await startCheckout(staff.cookie, {
      type: 'renew',
      planId: plan.id,
      provider: 'jazzcash',
    });
    expect(res.status).toBe(403);
  });
});

describe('Online payments — only a signed callback settles anything', () => {
  const initiate = async (cookie: string, planId: string) => {
    const res = await startCheckout(cookie, { type: 'renew', planId, provider: 'jazzcash' });
    return res.body as { intentId: string; fields: Record<string, string> };
  };

  it('rejects a callback with no signature', async () => {
    const { account, plan, member } = await setup();
    const started = await initiate(account.cookie, plan.id);

    const res = await api()
      .post('/api/online-payments/callback/jazzcash')
      .type('form')
      .send({
        pp_TxnRefNo: started.fields.pp_TxnRefNo,
        pp_Amount: '300000',
        pp_ResponseCode: '000',
      });

    expect(res.status).toBe(400);
    expect(await prisma.membership.count({ where: { memberId: member.id } })).toBe(0);
  });

  it('rejects a forged signature', async () => {
    const { account, plan, member } = await setup();
    const started = await initiate(account.cookie, plan.id);

    const res = await api()
      .post('/api/online-payments/callback/jazzcash')
      .type('form')
      .send({
        pp_TxnRefNo: started.fields.pp_TxnRefNo,
        pp_Amount: '300000',
        pp_ResponseCode: '000',
        pp_SecureHash: 'A'.repeat(64),
      });

    expect(res.status).toBe(400);
    expect(await prisma.membership.count({ where: { memberId: member.id } })).toBe(0);
  });

  it('rejects a correctly signed callback that underpays', async () => {
    const { account, plan, member } = await setup();
    const started = await initiate(account.cookie, plan.id);

    // Signed with the real salt, but for Rs. 1 against a Rs. 3000 plan — the
    // case a signature check alone would happily let through.
    const res = await api()
      .post('/api/online-payments/callback/jazzcash')
      .type('form')
      .send(
        signedCallback({
          pp_TxnRefNo: started.fields.pp_TxnRefNo,
          pp_Amount: '100',
          pp_ResponseCode: '000',
        }),
      );

    expect(res.status).toBe(400);
    expect(await prisma.membership.count({ where: { memberId: member.id } })).toBe(0);

    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: started.intentId } });
    expect(intent.status).toBe('failed');
    expect(intent.failureReason).toContain('amount mismatch');
  });

  it('grants the membership on a valid callback', async () => {
    const { account, plan, member } = await setup();
    const started = await initiate(account.cookie, plan.id);

    const res = await api()
      .post('/api/online-payments/callback/jazzcash')
      .type('form')
      .send(
        signedCallback({
          pp_TxnRefNo: started.fields.pp_TxnRefNo,
          pp_Amount: '300000', // 3000 rupees in paisa
          pp_ResponseCode: '000',
        }),
      );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paid');

    const memberships = await prisma.membership.findMany({ where: { memberId: member.id } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.pricePaid.toNumber()).toBe(3000);
    expect(memberships[0]!.status).toBe('active');

    const payments = await prisma.payment.findMany({ where: { memberId: member.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0]!.status).toBe('paid');
    expect(payments[0]!.method).toBe('online');
    expect(payments[0]!.membershipId).toBe(memberships[0]!.id);
  });

  it('is idempotent: a replayed callback grants nothing further', async () => {
    const { account, plan, member } = await setup();
    const started = await initiate(account.cookie, plan.id);
    const body = signedCallback({
      pp_TxnRefNo: started.fields.pp_TxnRefNo,
      pp_Amount: '300000',
      pp_ResponseCode: '000',
    });

    const send = () =>
      api().post('/api/online-payments/callback/jazzcash').type('form').send(body);

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);

    expect(await prisma.membership.count({ where: { memberId: member.id } })).toBe(1);
    expect(await prisma.payment.count({ where: { memberId: member.id } })).toBe(1);
  });

  it('survives two callbacks arriving at once without double-granting', async () => {
    const { account, plan, member } = await setup();
    const started = await initiate(account.cookie, plan.id);
    const body = signedCallback({
      pp_TxnRefNo: started.fields.pp_TxnRefNo,
      pp_Amount: '300000',
      pp_ResponseCode: '000',
    });

    await Promise.all(
      Array.from({ length: 4 }, () =>
        api().post('/api/online-payments/callback/jazzcash').type('form').send(body),
      ),
    );

    expect(await prisma.membership.count({ where: { memberId: member.id } })).toBe(1);
    expect(await prisma.payment.count({ where: { memberId: member.id } })).toBe(1);
  });

  it('records a declined payment as failed and grants nothing', async () => {
    const { account, plan, member } = await setup();
    const started = await initiate(account.cookie, plan.id);

    const res = await api()
      .post('/api/online-payments/callback/jazzcash')
      .type('form')
      .send(
        signedCallback({
          pp_TxnRefNo: started.fields.pp_TxnRefNo,
          pp_Amount: '300000',
          pp_ResponseCode: '157',
          pp_ResponseMessage: 'Insufficient balance',
        }),
      );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(await prisma.membership.count({ where: { memberId: member.id } })).toBe(0);

    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: started.intentId } });
    expect(intent.status).toBe('failed');
    expect(intent.failureReason).toContain('Insufficient balance');
  });

  it('refuses a callback for an intent whose window has closed', async () => {
    const { account, plan, member } = await setup();
    const started = await initiate(account.cookie, plan.id);

    await prisma.paymentIntent.update({
      where: { id: started.intentId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await api()
      .post('/api/online-payments/callback/jazzcash')
      .type('form')
      .send(
        signedCallback({
          pp_TxnRefNo: started.fields.pp_TxnRefNo,
          pp_Amount: '300000',
          pp_ResponseCode: '000',
        }),
      );

    expect(res.status).toBe(400);
    expect(await prisma.membership.count({ where: { memberId: member.id } })).toBe(0);

    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: started.intentId } });
    expect(intent.status).toBe('expired');
  });

  it('rejects a callback for a reference that was never issued', async () => {
    await setup();
    const res = await api()
      .post('/api/online-payments/callback/jazzcash')
      .type('form')
      .send(
        signedCallback({
          pp_TxnRefNo: 'T20260101000000deadbeef',
          pp_Amount: '300000',
          pp_ResponseCode: '000',
        }),
      );

    expect(res.status).toBe(404);
    expect(await prisma.membership.count()).toBe(0);
  });

  it('settles an outstanding due on a valid callback', async () => {
    const { owner, member, account } = await setup();
    const due = await prisma.payment.create({
      data: { gymId: owner.gymId, memberId: member.id, amount: 1500, status: 'due', method: 'cash' },
    });

    const start = await startCheckout(account.cookie, {
      type: 'due',
      paymentId: due.id,
      provider: 'jazzcash',
    });

    const res = await api()
      .post('/api/online-payments/callback/jazzcash')
      .type('form')
      .send(
        signedCallback({
          pp_TxnRefNo: start.body.fields.pp_TxnRefNo,
          pp_Amount: '150000',
          pp_ResponseCode: '000',
        }),
      );

    expect(res.status).toBe(200);
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: due.id } });
    expect(after.status).toBe('paid');
    expect(after.method).toBe('online');
    // No second payment row: settling a due updates the one already recorded.
    expect(await prisma.payment.count({ where: { memberId: member.id } })).toBe(1);
  });

  it('chains a renewal onto an unexpired membership', async () => {
    const { account, plan, member } = await setup();

    const buy = async () => {
      const started = await initiate(account.cookie, plan.id);
      await api()
        .post('/api/online-payments/callback/jazzcash')
        .type('form')
        .send(
          signedCallback({
            pp_TxnRefNo: started.fields.pp_TxnRefNo,
            pp_Amount: '300000',
            pp_ResponseCode: '000',
          }),
        );
    };

    await buy();
    await buy();

    const memberships = await prisma.membership.findMany({
      where: { memberId: member.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(memberships).toHaveLength(2);
    // The second term begins where the first ends, so the member keeps the
    // days they already paid for.
    expect(memberships[1]!.startDate.toISOString()).toBe(memberships[0]!.expiryDate.toISOString());
  });

  it('writes an audit entry naming the gateway, not the member', async () => {
    const { account, plan, owner } = await setup();
    const started = await initiate(account.cookie, plan.id);

    await api()
      .post('/api/online-payments/callback/jazzcash')
      .type('form')
      .send(
        signedCallback({
          pp_TxnRefNo: started.fields.pp_TxnRefNo,
          pp_Amount: '300000',
          pp_ResponseCode: '000',
        }),
      );

    const entries = await prisma.auditLog.findMany({
      where: { gymId: owner.gymId, entity: 'paymentIntent' },
    });
    const paid = entries.find((e) => e.action === 'onlinePayment.paid');
    expect(paid).toBeTruthy();
    expect(paid!.actorName).toContain('jazzcash');
  });
});

describe('Online payments — front-desk fallback', () => {
  it('files a pending request and grants nothing until staff confirm', async () => {
    const { owner, account, plan, member } = await setup();

    const started = await startCheckout(account.cookie, {
      type: 'renew',
      planId: plan.id,
      provider: 'manual',
    });
    expect(started.status).toBe(201);
    // Nothing to redirect to — the member pays at the counter.
    expect(started.body.url).toBe('');
    expect(await prisma.membership.count({ where: { memberId: member.id } })).toBe(0);

    const confirm = await api()
      .post(`/api/online-payments/${started.body.intentId}/confirm`)
      .set('Cookie', owner.cookie)
      .send({});
    expect(confirm.status).toBe(200);

    expect(await prisma.membership.count({ where: { memberId: member.id } })).toBe(1);
  });

  it('never lets staff hand-confirm a real gateway payment', async () => {
    const { owner, account, plan, member } = await setup();

    const started = await startCheckout(account.cookie, {
      type: 'renew',
      planId: plan.id,
      provider: 'jazzcash',
    });

    const confirm = await api()
      .post(`/api/online-payments/${started.body.intentId}/confirm`)
      .set('Cookie', owner.cookie)
      .send({});

    expect(confirm.status).toBe(400);
    expect(await prisma.membership.count({ where: { memberId: member.id } })).toBe(0);
  });

  it('refuses a member trying to confirm their own request', async () => {
    const { account, plan, member } = await setup();
    const started = await startCheckout(account.cookie, {
      type: 'renew',
      planId: plan.id,
      provider: 'manual',
    });

    const confirm = await api()
      .post(`/api/online-payments/${started.body.intentId}/confirm`)
      .set('Cookie', account.cookie)
      .send({});

    expect(confirm.status).toBe(403);
    expect(await prisma.membership.count({ where: { memberId: member.id } })).toBe(0);
  });

  it('refuses to confirm the same request twice', async () => {
    const { owner, account, plan, member } = await setup();
    const started = await startCheckout(account.cookie, {
      type: 'renew',
      planId: plan.id,
      provider: 'manual',
    });

    const confirm = () =>
      api()
        .post(`/api/online-payments/${started.body.intentId}/confirm`)
        .set('Cookie', owner.cookie)
        .send({});

    expect((await confirm()).status).toBe(200);
    expect((await confirm()).status).toBe(409);
    expect(await prisma.membership.count({ where: { memberId: member.id } })).toBe(1);
  });

  it('refuses to confirm an intent from another gym', async () => {
    const { account, plan } = await setup();
    const started = await startCheckout(account.cookie, {
      type: 'renew',
      planId: plan.id,
      provider: 'manual',
    });

    const outsider = await makeGym({ gymName: 'Rival Gym' });
    const confirm = await api()
      .post(`/api/online-payments/${started.body.intentId}/confirm`)
      .set('Cookie', outsider.cookie)
      .send({});

    expect(confirm.status).toBe(404);
  });
});

describe('Online payments — plans and providers', () => {
  it('lists active plans for a member', async () => {
    const { account } = await setup();
    const res = await api().get('/api/online-payments/plans').set('Cookie', account.cookie);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('offers the configured gateway rather than the front-desk fallback', async () => {
    const { account } = await setup();
    const res = await api().get('/api/online-payments/providers').set('Cookie', account.cookie);
    expect(res.status).toBe(200);
    expect(res.body.map((p: { provider: string }) => p.provider)).toContain('jazzcash');
    expect(res.body.map((p: { provider: string }) => p.provider)).not.toContain('manual');
  });

  it('refuses a provider that has no credentials configured', async () => {
    const { account, plan } = await setup();
    // Easypaisa is deliberately left unconfigured in this suite.
    const res = await startCheckout(account.cookie, {
      type: 'renew',
      planId: plan.id,
      provider: 'easypaisa',
    });
    expect(res.status).toBe(400);
  });
});
