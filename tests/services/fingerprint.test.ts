import { describe, expect, it } from 'vitest';

import { noDevice } from '../../src/services/fingerprint/none.js';
import type {
  CaptureResult,
  FingerprintDevice,
  IdentifyResult,
  Template,
} from '../../src/services/fingerprint/types.js';

/**
 * The contract a reader has to keep, exercised against fakes.
 *
 * Written before any hardware exists, and deliberately so: these are the
 * expectations a real adapter can be checked against on the bench, before it
 * is carried to a gym. Point them at a new file in
 * `src/services/fingerprint/` and they say whether it behaves.
 *
 * Both device shapes appear here because the interface serves both — one that
 * matches internally and one that hands back a template for the caller to
 * match. See `services/fingerprint/README.md`.
 */

const template = (bytes: string, format = 'fake-v1'): Template => ({
  data: Buffer.from(bytes),
  format,
});

/** A reader that holds its own store and answers `identify` directly. */
const makeLocalMatcher = (enrolled: Map<string, string>): FingerprintDevice => ({
  id: 'fake-local',
  label: 'Fake local-matching reader',
  format: 'fake-v1',
  matchesLocally: true,
  isConfigured: () => true,
  isOnline: () => Promise.resolve(true),
  capture: () => Promise.resolve({ ok: true, template: template('finger'), quality: 90 }),
  identify: () => {
    const first = [...enrolled.keys()][0];
    return Promise.resolve(
      first
        ? ({ ok: true, externalId: first, score: 95 } satisfies IdentifyResult)
        : ({ ok: false, reason: 'no_match' } satisfies IdentifyResult),
    );
  },
  match: () => Promise.reject(new Error('device matches internally')),
  enroll: (id, t) => {
    enrolled.set(id, t.data.toString());
    return Promise.resolve();
  },
  forget: (id) => {
    enrolled.delete(id);
    return Promise.resolve();
  },
});

/** A bare scanner: captures, and leaves matching to the caller. */
const makeCaptureOnly = (captured: CaptureResult): FingerprintDevice => ({
  id: 'fake-scanner',
  label: 'Fake capture-only scanner',
  format: 'fake-v1',
  matchesLocally: false,
  isConfigured: () => true,
  isOnline: () => Promise.resolve(true),
  capture: () => Promise.resolve(captured),
  identify: () => Promise.reject(new Error('device cannot match')),
  match: (probe, candidates) => {
    const hit = candidates.find(
      (c) =>
        c.template.format === probe.format &&
        c.template.data.equals(probe.data),
    );
    return Promise.resolve(
      hit
        ? ({ ok: true, externalId: hit.externalId, score: 99 } satisfies IdentifyResult)
        : ({ ok: false, reason: 'no_match' } satisfies IdentifyResult),
    );
  },
  enroll: () => Promise.resolve(),
  forget: () => Promise.resolve(),
});

describe('noDevice', () => {
  it('reports itself unconfigured and offline', async () => {
    expect(noDevice.isConfigured()).toBe(false);
    await expect(noDevice.isOnline()).resolves.toBe(false);
  });

  it('refuses every read rather than inventing a member', async () => {
    // The point of the stub: a fake success here would write attendance for
    // whoever happened to be first in the list, which is worse than a tab that
    // says it is not set up.
    await expect(noDevice.capture()).resolves.toEqual({
      ok: false,
      reason: 'device_offline',
    });
    await expect(noDevice.identify()).resolves.toEqual({
      ok: false,
      reason: 'device_offline',
    });
    await expect(noDevice.match(template('x'), [])).resolves.toEqual({
      ok: false,
      reason: 'device_offline',
    });
  });

  it('treats enrol and forget as no-ops rather than errors', async () => {
    // The caller has already written the row; there is no device store to keep
    // in step, and throwing would turn a successful enrolment into a failure.
    await expect(noDevice.enroll('member-1', template('x'))).resolves.toBeUndefined();
    await expect(noDevice.forget('member-1')).resolves.toBeUndefined();
  });
});

describe('a locally-matching reader', () => {
  it('identifies an enrolled finger', async () => {
    const device = makeLocalMatcher(new Map([['member-1', 'finger']]));
    await expect(device.identify()).resolves.toEqual({
      ok: true,
      externalId: 'member-1',
      score: 95,
    });
  });

  it('reports no_match rather than failing when nobody is enrolled', async () => {
    // An unenrolled member at the reader is an ordinary Tuesday, not an error.
    const device = makeLocalMatcher(new Map());
    await expect(device.identify()).resolves.toEqual({
      ok: false,
      reason: 'no_match',
    });
  });

  it('forgets an id, and forgetting an absent one still succeeds', async () => {
    const store = new Map([['member-1', 'finger']]);
    const device = makeLocalMatcher(store);

    await device.forget('member-1');
    expect(store.has('member-1')).toBe(false);

    // Deleting something already gone is the outcome that was asked for.
    await expect(device.forget('member-1')).resolves.toBeUndefined();
  });

  it('replaces rather than accumulates on re-enrolment', async () => {
    const store = new Map<string, string>();
    const device = makeLocalMatcher(store);

    await device.enroll('member-1', template('first'));
    await device.enroll('member-1', template('second'));

    expect(store.size).toBe(1);
    expect(store.get('member-1')).toBe('second');
  });
});

describe('a capture-only scanner', () => {
  const enrolled = [
    { externalId: 'member-1', template: template('alice') },
    { externalId: 'member-2', template: template('bob') },
  ];

  it('matches a probe against the enrolled set', async () => {
    const device = makeCaptureOnly({ ok: true, template: template('bob'), quality: 80 });
    const scan = await device.capture();
    expect(scan.ok).toBe(true);

    const result = await device.match(template('bob'), enrolled);
    expect(result).toEqual({ ok: true, externalId: 'member-2', score: 99 });
  });

  it('returns no_match for a finger nobody enrolled', async () => {
    const device = makeCaptureOnly({ ok: true, template: template('carol'), quality: 80 });
    await expect(device.match(template('carol'), enrolled)).resolves.toEqual({
      ok: false,
      reason: 'no_match',
    });
  });

  it('never matches across template formats', async () => {
    // A template from a different make is unreadable, not merely different.
    // Matching one would be a false positive at the door.
    const device = makeCaptureOnly({ ok: true, template: template('alice'), quality: 80 });
    const foreign = template('alice', 'other-vendor-v2');
    await expect(device.match(foreign, enrolled)).resolves.toEqual({
      ok: false,
      reason: 'no_match',
    });
  });

  it('surfaces a bad scan as a reason the desk can act on', async () => {
    const device = makeCaptureOnly({ ok: false, reason: 'poor_quality' });
    await expect(device.capture()).resolves.toEqual({
      ok: false,
      reason: 'poor_quality',
    });
  });
});
