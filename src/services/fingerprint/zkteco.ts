import { createRequire } from 'node:module';
import prisma from '../../db.js';
import { formatMemberNo } from '../membership.js';
import type {
  CaptureResult,
  FingerprintDevice,
  IdentifyResult,
} from './types.js';

/**
 * ZKTeco standalone network reader (K40, K50, F18 and the rest of that family).
 *
 * These devices keep their own users and fingerprints and match internally, so
 * the division of labour is different from a bare scanner:
 *
 *   - **Enrolment happens on the machine.** `beginDeviceEnrol` puts the member
 *     on the device and starts its enrolment screen; the member then places the
 *     same finger three times and the machine itself says whether each was
 *     right. No template ever comes back over the wire, which is why `capture`
 *     here only reports `device_offline` and the enrolment dialog uses the
 *     device flow instead.
 *   - **Check-in is an event.** The device announces each verified finger; the
 *     adapter waits for the next one and returns who it was.
 *
 * Device user ids are numbers (a 9-character string, at most), so a member is
 * stored on the machine under the number in their member number —
 * `MEM-00012` is user `12`. Identify answers with `memberNo:MEM-00012`, which
 * the controller resolves inside the gym it is serving; the adapter never
 * guesses a tenant.
 *
 * Wire protocol is `zkteco-js`'s. Each operation opens its own short
 * connection and closes it, because these units allow few simultaneous
 * sessions and a connection left open overnight is one the next restart finds
 * still occupied.
 *
 * Not supported by the library, and so not here: a device with a **Comm Key**
 * set (leave it at 0 in the machine's Comm menu) and template download, which
 * means the database holds no copy of the fingerprints — see the README.
 */

const require = createRequire(import.meta.url);

/** The slice of zkteco-js's TCP client this adapter uses. */
interface ZkClient {
  createSocket(): Promise<unknown>;
  connect(): Promise<boolean>;
  disconnect(): Promise<unknown>;
  executeCmd(command: number, data: Buffer | string): Promise<Buffer>;
  getTime(): Promise<unknown>;
  getUsers(): Promise<{ data: { userId?: string; user_id?: string }[] }>;
  setUser(
    uid: number,
    userid: string,
    name: string,
    password: string,
    role?: number,
    cardno?: number,
  ): Promise<Buffer>;
  deleteUser(uid: number): Promise<Buffer>;
  getRealTimeLogs(cb: (log: { userId: string }) => void): Promise<void>;
}
type ZkClientCtor = new (ip: string, port: number, timeout: number) => ZkClient;

const ZTCP = require('zkteco-js/src/ztcp') as ZkClientCtor;

// Command and reply codes from the ZK protocol.
const CMD_STARTENROLL = 61;
const CMD_CANCELCAPTURE = 62;
const ACK_OK = 2000;

const FORMAT = 'zkteco-device';

const host = (): string => process.env['ZKTECO_HOST'] ?? '';
const port = (): number => Number(process.env['ZKTECO_PORT'] ?? 4370) || 4370;
const timeoutMs = (): number => Number(process.env['ZKTECO_TIMEOUT_MS'] ?? 5000) || 5000;

/** Runs `fn` on a fresh connection and always closes it. */
const withSession = async <T>(fn: (zk: ZkClient) => Promise<T>): Promise<T> => {
  const zk = new ZTCP(host(), port(), timeoutMs());
  await zk.createSocket();
  try {
    await zk.connect();
    return await fn(zk);
  } finally {
    await zk.disconnect().catch(() => undefined);
  }
};

/** Whether a command reply is the device saying yes. */
const accepted = (reply: Buffer | undefined): boolean =>
  Boolean(reply && reply.length >= 2 && reply.readUInt16LE(0) === ACK_OK);

/** The number a member is stored under on the device, from their member number. */
const deviceNumber = async (memberId: string): Promise<number> => {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { memberNo: true },
  });
  const n = Number(/(\d+)$/.exec(member?.memberNo ?? '')?.[1]);
  // The library takes 1..3000, which is also what these units hold.
  if (!Number.isInteger(n) || n < 1 || n > 3000) {
    throw new Error(`Member number ${member?.memberNo ?? '(missing)'} does not fit the reader's 1-3000 user range`);
  }
  return n;
};

/** Pads a device user id as the enrolment command wants it: 24 bytes of ASCII. */
const enrolPayload = (deviceUserId: string, finger: number): Buffer => {
  const buf = Buffer.alloc(26);
  buf.write(deviceUserId, 0, 24, 'ascii');
  buf.writeUInt8(finger, 24);
  buf.writeUInt8(1, 25); // flag: store the enrolled finger on the device
  return buf;
};

export const zkteco: FingerprintDevice = {
  id: 'zkteco',
  label: 'ZKTeco Biometric Reader',
  format: FORMAT,
  matchesLocally: true,
  enrolOnDevice: true,

  isConfigured: () => host().trim() !== '',

  isOnline: async () => {
    try {
      await withSession((zk) => zk.getTime());
      return true;
    } catch {
      return false;
    }
  },

  // No template comes back from these devices. Enrolment goes through
  // `beginDeviceEnrol`, and a caller asking for a capture gets the honest
  // answer rather than random bytes.
  capture: async (): Promise<CaptureResult> => ({ ok: false, reason: 'error' }),

  identify: async (opts): Promise<IdentifyResult> => {
    const waitMs = opts?.timeoutMs ?? 20_000;
    const zk = new ZTCP(host(), port(), timeoutMs());
    try {
      await zk.createSocket();
      await zk.connect();
    } catch {
      return { ok: false, reason: 'device_offline' };
    }

    try {
      const userId = await new Promise<string | null>((resolve, reject) => {
        const timer = setTimeout(() => resolve(null), waitMs);
        zk.getRealTimeLogs((log) => {
          clearTimeout(timer);
          resolve(log.userId ?? null);
        }).catch((err: unknown) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      if (userId === null) return { ok: false, reason: 'timeout' };
      const n = Number(userId);
      // Somebody enrolled on the machine by hand, outside this application.
      if (!Number.isInteger(n) || n < 1) return { ok: false, reason: 'no_match' };
      // The device does not say how confident it was; it only reports people it
      // recognised, so a recognised finger is as good as the unit can say.
      return { ok: true, externalId: `memberNo:${formatMemberNo(n)}`, score: 100 };
    } catch {
      return { ok: false, reason: 'error' };
    } finally {
      await zk.disconnect().catch(() => undefined);
    }
  },

  match: async (): Promise<IdentifyResult> => {
    throw new Error('Device matches internally');
  },

  // Nothing to push: the finger was taken on the device and is already there.
  enroll: async () => {},

  forget: async (externalId: string): Promise<void> => {
    let uid: number;
    try {
      uid = await deviceNumber(externalId);
    } catch {
      return; // not a number the device could hold, so it cannot be on it
    }
    await withSession((zk) => zk.deleteUser(uid));
  },

  beginDeviceEnrol: async (externalId, { name, finger = 6 }) => {
    const uid = await deviceNumber(externalId);
    const deviceUserId = String(uid);
    return withSession(async (zk) => {
      // Name is at most 24 bytes on the device and is shown on its screen.
      const shown = name.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 24) || deviceUserId;
      await zk.setUser(uid, deviceUserId, shown, '');
      // Whatever the machine was doing, stop it first: a half-finished capture
      // makes it refuse the enrolment command.
      await zk.executeCmd(CMD_CANCELCAPTURE, '').catch(() => undefined);
      const reply = await zk.executeCmd(CMD_STARTENROLL, enrolPayload(deviceUserId, finger));
      if (!accepted(reply)) {
        throw new Error('The reader refused to start enrolment');
      }
      return { deviceUserId };
    });
  },

  hasDeviceEnrolment: async (externalId) => {
    const uid = await deviceNumber(externalId);
    const { data } = await withSession((zk) => zk.getUsers());
    return data.some((u) => (u.userId ?? u.user_id) === String(uid));
  },
};
