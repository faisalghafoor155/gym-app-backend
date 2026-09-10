/** @format */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The WhatsApp transport.
 *
 * Two things are worth holding down here, and neither is the HTTP call itself.
 *
 * The first is that an unusable number never reaches Meta. A landline in the
 * phone column is ordinary — gyms record them — and the send has to recognise
 * that as "nobody to tell" rather than as a failure, because a caller counting
 * failures will otherwise report a problem that does not exist.
 *
 * The second is the shape of the request. Meta matches template variables by
 * position, so a body that puts them in the wrong order is not rejected: it
 * arrives, correctly formatted, saying the wrong thing.
 *
 * The module reads its configuration at import time, so each test imports it
 * fresh with the environment it wants.
 */

const ORIGINAL_ENV = { ...process.env };

/** Imports the module with WhatsApp configured, after resetting the registry
 *  so the previous test's environment is not still baked in. */
const importConfigured = async () => {
  vi.resetModules();
  process.env.WHATSAPP_TOKEN = 'test-token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
  return import('../../src/services/whatsapp.js');
};

const importUnconfigured = async () => {
  vi.resetModules();
  delete process.env.WHATSAPP_TOKEN;
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  return import('../../src/services/whatsapp.js');
};

/** A fetch that succeeds, and records what it was asked to send. */
const stubFetch = (ok = true, status = 200, body = '{}') => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    text: () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

describe('sendWhatsApp — who it will not send to', () => {
  it('skips a number WhatsApp cannot reach, without calling Meta', async () => {
    const { sendWhatsApp } = await importConfigured();
    const fetchMock = stubFetch();

    // A landline. Not a failure — there is simply nobody to tell.
    const result = await sendWhatsApp({
      to: '042-35881234',
      template: 'member_welcome',
      variables: ['Ali', 'Iron House', 'MEM-001'],
    });

    expect(result).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips an empty number', async () => {
    const { sendWhatsApp } = await importConfigured();
    const fetchMock = stubFetch();

    const result = await sendWhatsApp({
      to: '',
      template: 'member_welcome',
      variables: [],
    });

    expect(result).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tells a skip apart from a failure when nothing is configured', async () => {
    const { sendWhatsApp, whatsappEnabled } = await importUnconfigured();
    const fetchMock = stubFetch();

    expect(whatsappEnabled).toBe(false);

    // An unusable number is still a skip even with no transport: the two
    // questions are independent, and the number is answered first.
    expect(await sendWhatsApp({
      to: '042-35881234', template: 'member_welcome', variables: [],
    })).toBe('skipped');

    // A usable number with no transport is a failure, so a caller can see
    // that somebody who should have been told was not.
    expect(await sendWhatsApp({
      to: '03001234567', template: 'member_welcome', variables: [],
    })).toBe('failed');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sendWhatsApp — what it sends', () => {
  it('addresses the member in the form Meta wants', async () => {
    const { sendWhatsApp } = await importConfigured();
    const fetchMock = stubFetch();

    await sendWhatsApp({
      to: '0300-1234567',
      template: 'member_welcome',
      variables: ['Ali Khan', 'Iron House', 'MEM-00125'],
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body);
    // Converted from what the gym typed: country code, no plus, no zero.
    expect(body.to).toBe('923001234567');
    expect(body.type).toBe('template');
    expect(body.template.name).toBe('member_welcome');
  });

  it('keeps the variables in the order they were given', async () => {
    const { sendWhatsApp } = await importConfigured();
    const fetchMock = stubFetch();

    await sendWhatsApp({
      to: '03001234567',
      template: 'payment_receipt',
      variables: ['Ali Khan', 'Iron House', '2500', 'Monthly'],
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body);
    // Meta fills {{1}}, {{2}}… by position. Reordered, this still delivers —
    // it just tells the member their name is 2500.
    expect(body.template.components[0].parameters).toEqual([
      { type: 'text', text: 'Ali Khan' },
      { type: 'text', text: 'Iron House' },
      { type: 'text', text: '2500' },
      { type: 'text', text: 'Monthly' },
    ]);
  });

  it('sends no components for a template that takes none', async () => {
    const { sendWhatsApp } = await importConfigured();
    const fetchMock = stubFetch();

    await sendWhatsApp({ to: '03001234567', template: 'plain', variables: [] });

    const [, init] = fetchMock.mock.calls[0]!;
    // An empty `parameters` array against a template with no placeholders is
    // a mismatch Meta rejects, so the component is omitted entirely.
    expect(JSON.parse(init.body).template.components).toEqual([]);
  });

  it('authenticates and posts to the configured number', async () => {
    const { sendWhatsApp } = await importConfigured();
    const fetchMock = stubFetch();

    await sendWhatsApp({ to: '03001234567', template: 'x', variables: [] });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/123456789/messages');
    expect(init.headers.Authorization).toBe('Bearer test-token');
  });
});

describe('sendWhatsApp — when Meta refuses', () => {
  it('reports a failure rather than throwing', async () => {
    const { sendWhatsApp } = await importConfigured();
    stubFetch(false, 400, '{"error":{"message":"Template not found"}}');

    // These are sent alongside a payment being recorded. A rejection must not
    // become an exception that fails the thing it was announcing.
    const result = await sendWhatsApp({
      to: '03001234567', template: 'missing', variables: [],
    });

    expect(result).toBe('failed');
  });

  it('reports a failure when the network is down', async () => {
    const { sendWhatsApp } = await importConfigured();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await sendWhatsApp({
      to: '03001234567', template: 'member_welcome', variables: [],
    });

    expect(result).toBe('failed');
  });

  it('logs what Meta said, so the reason is not lost', async () => {
    const { sendWhatsApp } = await importConfigured();
    stubFetch(false, 400, '{"error":{"message":"Template name does not exist"}}');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await sendWhatsApp({ to: '03001234567', template: 'nope', variables: [] });

    // An unapproved template and an expired token both read as a 4xx. The
    // body is the only thing that tells them apart.
    expect(err.mock.calls.flat().join(' ')).toContain('Template name does not exist');
  });
});

describe('templates', () => {
  it('names each template and orders its variables', async () => {
    const { templates } = await importConfigured();

    expect(templates.membershipExpiry('Ali', 'Iron House', 'Monthly')).toEqual({
      template: 'membership_expiry',
      variables: ['Ali', 'Iron House', 'Monthly'],
    });

    expect(templates.membershipExpiringSoon('Ali', 'Iron House', 'Monthly', '3')).toEqual({
      template: 'membership_expiring_soon',
      variables: ['Ali', 'Iron House', 'Monthly', '3'],
    });

    expect(templates.welcome('Ali', 'Iron House', 'MEM-001')).toEqual({
      template: 'member_welcome',
      variables: ['Ali', 'Iron House', 'MEM-001'],
    });

    // The date is the fifth slot. Meta matches these by position against the
    // approved body, so this order is a contract with the template in the
    // console, not an implementation detail.
    expect(
      templates.paymentReceipt('Ali', 'Iron House', '2500', 'Monthly', '3 September 2026'),
    ).toEqual({
      template: 'payment_receipt',
      variables: ['Ali', 'Iron House', '2500', 'Monthly', '3 September 2026'],
    });
  });
});
