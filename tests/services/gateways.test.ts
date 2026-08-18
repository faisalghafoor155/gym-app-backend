import { beforeEach, describe, expect, it } from 'vitest';
import { jazzcash } from '../../src/services/gateways/jazzcash.js';
import { easypaisa } from '../../src/services/gateways/easypaisa.js';
import { manual } from '../../src/services/gateways/manual.js';
import { availableGateways, getGateway } from '../../src/services/gateways/index.js';
import { hmacSha256Hex, safeEqual, sha256Hex, sortedConcat } from '../../src/services/gateways/crypto.js';

const SALT = 'unit-test-salt';
const HASHKEY = 'unit-test-hashkey';

const clearEnv = () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('JAZZCASH_') || k.startsWith('EASYPAISA_')) delete process.env[k];
  }
};

beforeEach(clearEnv);

describe('signature helpers', () => {
  it('sortedConcat orders by key and drops empty values', () => {
    // Empty fields are dropped by both providers before hashing; including
    // them here would produce a hash that never matches theirs.
    expect(sortedConcat({ b: '2', a: '1', c: '', d: null })).toBe('1&2');
  });

  it('sortedConcat excludes the signature field itself', () => {
    expect(sortedConcat({ a: '1', pp_SecureHash: 'X' }, ['pp_SecureHash'])).toBe('1');
  });

  it('safeEqual matches identical strings and rejects different ones', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
  });

  it('safeEqual reports a length mismatch as a plain non-match', () => {
    // timingSafeEqual throws on unequal lengths; that must not escape.
    expect(() => safeEqual('short', 'much longer string')).not.toThrow();
    expect(safeEqual('short', 'much longer string')).toBe(false);
  });
});

describe('jazzcash', () => {
  const configure = () => {
    process.env.JAZZCASH_MERCHANT_ID = 'M1';
    process.env.JAZZCASH_PASSWORD = 'P1';
    process.env.JAZZCASH_INTEGRITY_SALT = SALT;
  };

  const sign = (body: Record<string, string>): Record<string, string> => ({
    ...body,
    pp_SecureHash: hmacSha256Hex(SALT, `${SALT}&${sortedConcat(body)}`),
  });

  it('is not configured without its secrets', () => {
    expect(jazzcash.isConfigured()).toBe(false);
    configure();
    expect(jazzcash.isConfigured()).toBe(true);
  });

  it('sends the amount in paisa, not rupees', async () => {
    configure();
    const out = await jazzcash.initiate({
      intentId: '11111111-2222-3333-4444-555555555555',
      amount: 2500,
      description: 'Monthly',
      returnUrl: 'https://gym.example/return',
    });
    // Rs. 2500 is 250000 paisa. Sending 2500 would charge Rs. 25.
    expect(out.fields.pp_Amount).toBe('250000');
  });

  it('signs a form it would then accept back', async () => {
    configure();
    const out = await jazzcash.initiate({
      intentId: '11111111-2222-3333-4444-555555555555',
      amount: 2500,
      description: 'Monthly',
      returnUrl: 'https://gym.example/return',
    });
    // The signature the gateway produces must verify under its own rules.
    const verified = jazzcash.verifyCallback(out.fields);
    expect(verified.ok).toBe(true);
  });

  it('refuses to verify anything when no salt is set', () => {
    // A gateway with no secret cannot distinguish a real callback from a
    // forgery, so it must refuse rather than trust the body.
    const res = jazzcash.verifyCallback(sign({ pp_TxnRefNo: 'T1', pp_Amount: '100' }));
    expect(res.ok).toBe(false);
  });

  it('rejects a body with no signature', () => {
    configure();
    const res = jazzcash.verifyCallback({ pp_TxnRefNo: 'T1', pp_Amount: '100' });
    expect(res).toMatchObject({ ok: false });
  });

  it('rejects a tampered amount', () => {
    configure();
    const body = sign({ pp_TxnRefNo: 'T1', pp_Amount: '250000', pp_ResponseCode: '000' });
    body.pp_Amount = '100';
    expect(jazzcash.verifyCallback(body)).toMatchObject({ ok: false });
  });

  it('converts a verified amount back to rupees', () => {
    configure();
    const res = jazzcash.verifyCallback(
      sign({ pp_TxnRefNo: 'T1', pp_Amount: '250000', pp_ResponseCode: '000' }),
    );
    expect(res).toMatchObject({ ok: true, amount: 2500, paid: true });
  });

  it('reads a non-success response code as a declined payment', () => {
    configure();
    const res = jazzcash.verifyCallback(
      sign({
        pp_TxnRefNo: 'T1',
        pp_Amount: '250000',
        pp_ResponseCode: '157',
        pp_ResponseMessage: 'Insufficient balance',
      }),
    );
    // Declined, not forged: the signature was good, the payment was not.
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.paid).toBe(false);
      expect(res.failureReason).toContain('Insufficient balance');
    }
  });
});

describe('easypaisa', () => {
  const configure = () => {
    process.env.EASYPAISA_STORE_ID = 'S1';
    process.env.EASYPAISA_HASH_KEY = HASHKEY;
  };

  it('is not configured without its secrets', () => {
    expect(easypaisa.isConfigured()).toBe(false);
    configure();
    expect(easypaisa.isConfigured()).toBe(true);
  });

  it('sends the amount in rupees with two decimals, unlike jazzcash', async () => {
    configure();
    const out = await easypaisa.initiate({
      intentId: '11111111-2222-3333-4444-555555555555',
      amount: 2500,
      description: 'Monthly',
      returnUrl: 'https://gym.example/return',
    });
    expect(out.fields.amount).toBe('2500.00');
  });

  it('signs a form it would then accept back', async () => {
    configure();
    const out = await easypaisa.initiate({
      intentId: '11111111-2222-3333-4444-555555555555',
      amount: 2500,
      description: 'Monthly',
      returnUrl: 'https://gym.example/return',
    });
    expect(easypaisa.verifyCallback(out.fields).ok).toBe(true);
  });

  it('rejects a tampered amount', () => {
    configure();
    const body: Record<string, string> = { orderRefNum: 'O1', amount: '2500.00', status: '0000' };
    body.merchantHashedReq = sha256Hex(`${HASHKEY}&${sortedConcat(body)}`);
    body.amount = '1.00';
    expect(easypaisa.verifyCallback(body)).toMatchObject({ ok: false });
  });

  it('refuses to verify anything when no hash key is set', () => {
    expect(easypaisa.verifyCallback({ orderRefNum: 'O1' })).toMatchObject({ ok: false });
  });
});

describe('manual', () => {
  it('never verifies a callback, however the body is shaped', () => {
    // There is no secret behind `manual`, so there is no callback it could
    // honestly believe. Accepting one would be the hole this design closes.
    expect(manual.verifyCallback({ status: 'SUCCESS', amount: '9999' })).toMatchObject({
      ok: false,
    });
  });

  it('produces no redirect', async () => {
    const out = await manual.initiate({
      intentId: 'abc',
      amount: 100,
      description: 'x',
      returnUrl: 'y',
    });
    expect(out.url).toBe('');
  });
});

describe('registry', () => {
  it('resolves each known provider', () => {
    expect(getGateway('jazzcash')).toBe(jazzcash);
    expect(getGateway('easypaisa')).toBe(easypaisa);
    expect(getGateway('manual')).toBe(manual);
  });

  it('offers only the front-desk fallback when nothing is configured', () => {
    expect(availableGateways().map((g) => g.provider)).toEqual(['manual']);
  });

  it('hides the fallback once a real gateway is configured', () => {
    // Otherwise members learn to click "pay at the gym" and the front desk
    // reconciles by hand anyway.
    process.env.JAZZCASH_MERCHANT_ID = 'M1';
    process.env.JAZZCASH_PASSWORD = 'P1';
    process.env.JAZZCASH_INTEGRITY_SALT = SALT;
    const names = availableGateways().map((g) => g.provider);
    expect(names).toContain('jazzcash');
    expect(names).not.toContain('manual');
  });
});
