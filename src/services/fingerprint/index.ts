import type { FingerprintDevice } from './types.js';
import { noDevice } from './none.js';

export type {
  FingerprintDevice,
  Template,
  CaptureResult,
  CaptureFailure,
  IdentifyResult,
} from './types.js';

/**
 * Every reader the application knows how to speak to.
 *
 * Adding one means writing a single file against `FingerprintDevice` and
 * listing it here. Nothing in the controller, the routes or the UI learns its
 * name — same arrangement as `services/gateways`, for the same reason: the
 * check-in flow is written once and the hardware is data.
 *
 * ## Adding the real reader
 *
 * 1. `src/services/fingerprint/<vendor>.ts`, exporting a `FingerprintDevice`.
 *    `types.ts` says what each member has to do; the two that decide the shape
 *    of the rest are `matchesLocally` and `format`.
 * 2. Add it to `ALL` below.
 * 3. Give it the env vars its `isConfigured()` looks for.
 *
 * Nothing else changes. The endpoints, the Attendance tab and the enrolment UI
 * are already written against this interface, and `tests/services/fingerprint`
 * covers both device shapes with fakes, so a new file can be checked against
 * the same expectations before it is ever plugged in.
 */
const ALL: readonly FingerprintDevice[] = [
  // A real reader goes here. Until one does, `activeDevice()` falls back to
  // `noDevice` and the fingerprint tab renders as "not set up".
];

/**
 * The reader in use, or `noDevice` when none is configured.
 *
 * First configured wins. A gym runs one reader at its front desk; a list of
 * several is a deployment mistake worth failing predictably rather than
 * arbitrating between.
 */
export const activeDevice = (): FingerprintDevice =>
  ALL.find((d) => d.isConfigured()) ?? noDevice;

/** Whether any real reader is wired up. */
export const hasDevice = (): boolean => activeDevice() !== noDevice;
