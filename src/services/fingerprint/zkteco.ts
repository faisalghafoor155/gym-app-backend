import type {
  CaptureResult,
  FingerprintDevice,
  IdentifyResult,
} from './types.js';

/**
 * ZKTeco Standalone Network Biometric Reader — placeholder, not implemented.
 *
 * Nothing here talks to a reader yet, so it never reports itself configured:
 * an earlier version did whenever ZKTECO_HOST was set, and then stored a
 * blank template for every member. Implement `capture`/`identify` against
 * the device's protocol, then make `isConfigured` check ZKTECO_HOST again.
 */
export const zkteco: FingerprintDevice = {
  id: 'zkteco',
  label: 'ZKTeco Biometric Reader',
  format: 'zkteco-v10',
  matchesLocally: true,

  isConfigured: () => false,

  isOnline: async () => false,

  capture: async (): Promise<CaptureResult> => ({ ok: false, reason: 'device_offline' }),

  identify: async (): Promise<IdentifyResult> => {
    return { ok: false, reason: 'no_match' };
  },

  match: async (): Promise<IdentifyResult> => {
    throw new Error('Device matches internally');
  },

  enroll: async () => {},

  forget: async () => {},
};
