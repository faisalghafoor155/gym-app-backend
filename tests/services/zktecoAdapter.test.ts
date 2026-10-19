import { afterEach, describe, expect, it } from 'vitest';
import { zkteco } from '../../src/services/fingerprint/zkteco.js';

/**
 * The ZKTeco adapter, as far as it can be checked without the machine.
 *
 * The wire protocol needs a real reader, so this holds down what does not:
 * that it only switches on when an address is given, that it is honest about
 * not returning templates, and that an unreachable reader reads as offline
 * rather than hanging or throwing at the desk.
 */

const saved = { host: process.env['ZKTECO_HOST'], port: process.env['ZKTECO_PORT'] };
afterEach(() => {
  if (saved.host === undefined) delete process.env['ZKTECO_HOST'];
  else process.env['ZKTECO_HOST'] = saved.host;
  if (saved.port === undefined) delete process.env['ZKTECO_PORT'];
  else process.env['ZKTECO_PORT'] = saved.port;
});

describe('zkteco adapter', () => {
  it('is off until an address is configured', () => {
    delete process.env['ZKTECO_HOST'];
    expect(zkteco.isConfigured()).toBe(false);
    process.env['ZKTECO_HOST'] = '   ';
    expect(zkteco.isConfigured()).toBe(false);
    process.env['ZKTECO_HOST'] = '192.168.1.201';
    expect(zkteco.isConfigured()).toBe(true);
  });

  it('takes the finger on the device and never fabricates a capture', async () => {
    expect(zkteco.enrolOnDevice).toBe(true);
    expect(zkteco.matchesLocally).toBe(true);
    const result = await zkteco.capture();
    expect(result.ok).toBe(false);
  });

  it('reports an unreachable reader as offline', async () => {
    // Nothing listens here, so the connect is refused straight away.
    process.env['ZKTECO_HOST'] = '127.0.0.1';
    process.env['ZKTECO_PORT'] = '1';
    expect(await zkteco.isOnline()).toBe(false);
    expect(await zkteco.identify({ timeoutMs: 500 })).toEqual({ ok: false, reason: 'device_offline' });
  });
});
