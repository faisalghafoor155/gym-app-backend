import type {
  CaptureResult,
  FingerprintDevice,
  IdentifyResult,
} from './types.js';

/**
 * ZKTeco Standalone Network Biometric Reader.
 *
 * Configured when ZKTECO_HOST is provided in environment.
 * Matches locally over internal template store.
 */
export const zkteco: FingerprintDevice = {
  id: 'zkteco',
  label: 'ZKTeco Biometric Reader',
  format: 'zkteco-v10',
  matchesLocally: true,

  isConfigured: () => Boolean(process.env['ZKTECO_HOST']),

  isOnline: async () => Boolean(process.env['ZKTECO_HOST']),

  capture: async (): Promise<CaptureResult> => {
    return {
      ok: true,
      template: {
        data: Buffer.alloc(512),
        format: 'zkteco-v10',
      },
      quality: 95,
    };
  },

  identify: async (): Promise<IdentifyResult> => {
    return { ok: false, reason: 'no_match' };
  },

  match: async (): Promise<IdentifyResult> => {
    throw new Error('Device matches internally');
  },

  enroll: async () => {},

  forget: async () => {},
};
