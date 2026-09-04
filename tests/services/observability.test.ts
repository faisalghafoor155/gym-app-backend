/** @format */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  requestLogger,
  captureError,
  isSentryEnabled,
  log,
} from '../../src/services/observability.js';

/**
 * Request logging and error reporting.
 *
 * This code sits on every request in the application, which is the reason it is
 * tested at all: a logger that throws takes down the endpoint it was meant to
 * observe, and one that logs the wrong field leaks in a place nobody thinks to
 * look. Two things matter more than the format.
 *
 * The first is that **secrets never reach a log line**. A query string carries
 * password-reset tokens; a cookie header carries a session that would let the
 * reader sign in as the user. Logs get shipped, kept, and pasted into support
 * threads, so anything written here should be assumed to end up somewhere
 * public.
 *
 * The second is that a request id actually reaches the client. It is the only
 * thing connecting "it broke at 4pm" to the line that explains why.
 */

/** Captures stdout/stderr so the assertions can read what was logged. */
const captureConsole = () => {
  const lines: string[] = [];
  const collect = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(collect),
    vi.spyOn(console, 'warn').mockImplementation(collect),
    vi.spyOn(console, 'error').mockImplementation(collect),
  ];
  return {
    lines,
    restore: () => spies.forEach((s) => s.mockRestore()),
    /** The JSON log lines, parsed. Non-JSON output is ignored. */
    json: () =>
      lines
        .map((l) => {
          try {
            return JSON.parse(l) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((v): v is Record<string, unknown> => v !== null),
  };
};

let consoleCapture: ReturnType<typeof captureConsole>;

beforeEach(() => {
  consoleCapture = captureConsole();
});

afterEach(() => {
  consoleCapture.restore();
});

describe('requestLogger', () => {
  const appWith = (route: (app: express.Express) => void) => {
    const app = express();
    app.use(requestLogger);
    route(app);
    return app;
  };

  it('returns a request id the client can quote back', async () => {
    const app = appWith((a) => a.get('/thing', (_req, res) => res.json({ ok: true })));

    const res = await request(app).get('/thing');

    expect(res.status).toBe(200);
    // Without this header there is nothing to match a complaint against a log.
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('logs the method, path and status once the response is finished', async () => {
    const app = appWith((a) => a.get('/members', (_req, res) => res.status(201).json({})));

    const res = await request(app).get('/members');

    const line = consoleCapture.json().find((l) => l.msg === 'request');
    expect(line).toBeDefined();
    expect(line).toMatchObject({
      method: 'GET',
      path: '/members',
      status: 201,
    });
    // The status is only knowable after the handler has run, which is why the
    // line is written on finish rather than on the way in.
    expect(line!.requestId).toBe(res.headers['x-request-id']);
    expect(typeof line!.ms).toBe('number');
  });

  it('never writes the query string, which carries reset tokens', async () => {
    const app = appWith((a) => a.get('/reset', (_req, res) => res.json({})));

    await request(app).get('/reset?token=super-secret-reset-token&email=a@b.com');

    const line = consoleCapture.json().find((l) => l.msg === 'request');
    // `req.path` rather than `req.originalUrl` is the whole point: a reset
    // token in a log is a working password anyone reading it can use.
    expect(line!.path).toBe('/reset');
    expect(JSON.stringify(line)).not.toContain('super-secret-reset-token');
    expect(JSON.stringify(line)).not.toContain('a@b.com');
  });

  it('logs a 500 at error level so it can be alerted on separately', async () => {
    const app = appWith((a) =>
      a.get('/broken', (_req, res) => res.status(500).json({ error: 'Server error' })),
    );

    await request(app).get('/broken');

    const line = consoleCapture.json().find((l) => l.msg === 'request');
    expect(line!.level).toBe('error');
    expect(line!.status).toBe(500);
  });

  it('stays quiet for the health check', async () => {
    // Every container runs this every ten seconds. Logged, it would bury the
    // traffic somebody is actually trying to read.
    const app = express();
    app.use(requestLogger);
    app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

    await request(app).get('/api/health');

    expect(consoleCapture.json().filter((l) => l.msg === 'request')).toHaveLength(0);
  });

  it('still logs a failing health check', async () => {
    // The noise is only worth suppressing while it says nothing. A health
    // check that fails is the one time it is the most interesting line there.
    const app = express();
    app.use(requestLogger);
    app.get('/api/health', (_req, res) => res.status(503).json({ status: 'down' }));

    await request(app).get('/api/health');

    expect(consoleCapture.json().filter((l) => l.msg === 'request')).toHaveLength(1);
  });
});

describe('captureError', () => {
  it('logs the message and stack', () => {
    captureError(new Error('the database went away'));

    const line = consoleCapture.json().find((l) => l.msg === 'unhandled error');
    expect(line).toBeDefined();
    expect(line!.err).toBe('the database went away');
    expect(String(line!.stack)).toContain('Error: the database went away');
  });

  it('survives being handed something that is not an Error', () => {
    // `throw 'string'` is legal JavaScript and a rejected promise can settle
    // with anything at all. The reporter must not become the crash.
    expect(() => captureError('just a string')).not.toThrow();
    expect(() => captureError(undefined)).not.toThrow();

    const lines = consoleCapture.json().filter((l) => l.msg === 'unhandled error');
    expect(lines).toHaveLength(2);
    expect(lines[0]!.err).toBe('just a string');
  });

  it('is a no-op for Sentry when no DSN is configured', () => {
    // A gym running this on one machine should not need an account with
    // anyone. Without a DSN the structured log is the whole story.
    expect(isSentryEnabled()).toBe(false);
    expect(() => captureError(new Error('boom'))).not.toThrow();
  });
});

describe('log', () => {
  it('writes one JSON object per line', () => {
    log.info('something happened', { gymId: 'g1' });

    const line = consoleCapture.json().find((l) => l.msg === 'something happened');
    expect(line).toMatchObject({ level: 'info', gymId: 'g1' });
    // A timestamp the log shipper can sort on without parsing prose.
    expect(String(line!.ts)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
