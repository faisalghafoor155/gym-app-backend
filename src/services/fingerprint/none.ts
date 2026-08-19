import type {
  CaptureResult,
  FingerprintDevice,
  IdentifyResult,
} from './types.js';

/**
 * The "no reader plugged in" device, named honestly.
 *
 * This is what the registry returns until a real one is written, and it is
 * what keeps the rest of the feature buildable and testable before the
 * hardware has been bought. Every operation refuses with `device_offline`,
 * which is already a case the UI has to handle — a reader that is unplugged at
 * eight in the morning looks exactly like this.
 *
 * It deliberately does not pretend to succeed. A stub that returned a fake
 * member would make the check-in flow look finished while writing attendance
 * for whoever happened to be first in the list, and that is a worse failure
 * than a disabled tab: it is wrong quietly, and in the one part of the system
 * where being wrong quietly means a member is marked present who never came.
 */
export const noDevice: FingerprintDevice = {
  id: 'none',
  label: 'No fingerprint reader configured',
  format: 'none',

  isConfigured: () => false,
  isOnline: () => Promise.resolve(false),

  // Irrelevant while nothing is configured, but it has to be one or the other.
  // `false` is the safer default: it routes callers down the path that reads
  // templates from the database, which is the one with a working fallback.
  matchesLocally: false,

  capture: (): Promise<CaptureResult> =>
    Promise.resolve({ ok: false, reason: 'device_offline' }),

  identify: (): Promise<IdentifyResult> =>
    Promise.resolve({ ok: false, reason: 'device_offline' }),

  match: (): Promise<IdentifyResult> =>
    Promise.resolve({ ok: false, reason: 'device_offline' }),

  // Enrolment against no device is not an error worth throwing over: the
  // caller has already written the template to the database, and there is no
  // device store to keep in step. Doing nothing is the correct amount of work.
  enroll: () => Promise.resolve(),
  forget: () => Promise.resolve(),
};
