import crypto from 'node:crypto';
import prisma from '../../db.js';
import type {
  CaptureResult,
  FingerprintDevice,
  IdentifyResult,
} from './types.js';

/**
 * A pretend reader for demos and development. NOT a real scanner.
 *
 * It reads no finger: `capture` returns random bytes and `identify` simply
 * answers with the most recently enrolled member. Left on in a real gym it
 * would check in whoever was enrolled last for every finger placed, so it is
 * off unless `FINGERPRINT_SIMULATOR=true` is set explicitly.
 */
const enrolledMembers = new Set<string>();
let activeMemberId: string | null = null;

export const virtualScanner: FingerprintDevice = {
  id: 'biometric-scanner',
  label: 'Fingerprint Simulator (demo)',
  format: 'zkteco-v10',
  matchesLocally: true,

  isConfigured: () => process.env['FINGERPRINT_SIMULATOR'] === 'true',
  isOnline: () => Promise.resolve(true),

  capture: async (): Promise<CaptureResult> => {
    // Generate realistic biometric template
    const templateData = crypto.randomBytes(512);
    return {
      ok: true,
      template: {
        data: templateData,
        format: 'zkteco-v10',
      },
      quality: 96,
    };
  },

  identify: async (): Promise<IdentifyResult> => {
    if (activeMemberId && enrolledMembers.has(activeMemberId)) {
      return {
        ok: true,
        externalId: activeMemberId,
        score: 98,
      };
    }

    const first = Array.from(enrolledMembers)[0];
    if (first) {
      return {
        ok: true,
        externalId: first,
        score: 95,
      };
    }

    // Lookup any enrolled member in the database
    try {
      const latest = await prisma.fingerprintTemplate.findFirst({
        orderBy: { enrolledAt: 'desc' },
        select: { memberId: true },
      });
      if (latest) {
        enrolledMembers.add(latest.memberId);
        activeMemberId = latest.memberId;
        return {
          ok: true,
          externalId: latest.memberId,
          score: 95,
        };
      }
    } catch {
      // Database lookup silent catch
    }

    return {
      ok: false,
      reason: 'no_match',
    };
  },

  match: async (): Promise<IdentifyResult> => {
    throw new Error('Device matches internally');
  },

  enroll: async (memberId: string): Promise<void> => {
    enrolledMembers.add(memberId);
    activeMemberId = memberId;
  },

  forget: async (memberId: string): Promise<void> => {
    enrolledMembers.delete(memberId);
    if (activeMemberId === memberId) {
      activeMemberId = Array.from(enrolledMembers)[0] ?? null;
    }
  },
};
