/** @format */

import type { Response } from "express";
import prisma from "../db.js";
import { audit } from "../services/audit.js";
import { activeDevice } from "../services/fingerprint/index.js";
import {
  BiometricCryptoError,
  decryptTemplate,
  encryptTemplate,
} from "../services/fingerprint/crypto.js";
import { getPhotoUrl } from "../services/s3.js";
import type { Template } from "../services/fingerprint/index.js";
import type { AuthedRequest } from "../types.js";
import type {
  EnrollFingerprintBody,
  IdentifyFingerprintBody,
  IdParam,
} from "../schemas.js";

/**
 * Fingerprint enrolment, and turning a finger into a member id.
 *
 * Note what is *not* here: writing an attendance row. `identify` resolves a
 * member and stops. The client then posts that id to the check-in endpoint it
 * already uses for QR and manual entry, so the rules about what a check-in
 * means — one per day, the expired-membership warning, the race the unique
 * constraint settles — are stated once in `attendanceController` and cannot
 * drift out of step with a second copy here.
 *
 * Templates are encrypted before they reach the database and decrypted on the
 * way out — see `services/fingerprint/crypto.ts` for why and how. This file is
 * the only place that happens, so the plaintext exists here and nowhere else on
 * the server.
 */

/**
 * Swaps a stored photo key for a short-lived signed URL.
 *
 * The bucket is private, so an identified member's face is only reachable
 * through a signature minted for this reply. `photoKey` never leaves the
 * server — the client reads `photo`, as it always has.
 */
const signMemberPhoto = async <
  T extends { photo: string | null; photoKey: string | null },
>(
  member: T,
): Promise<Omit<T, "photoKey">> => {
  const { photoKey, ...rest } = member;
  return { ...rest, photo: member.photo ?? (await getPhotoUrl(photoKey)) };
};

/** What the desk is told when the reader is missing or unreachable. */
const deviceUnavailable = (res: Response): void => {
  const device = activeDevice();
  res.status(503).json({
    error: device.isConfigured()
      ? `${device.label} is not responding`
      : "No fingerprint reader is set up",
    // Lets the UI distinguish "never configured" — where the answer is to buy
    // and wire up a reader — from "configured but down", where the answer is
    // to check the cable. Both are 503; only one is worth paging anybody over.
    configured: device.isConfigured(),
  });
};

/**
 * Whether the gym has a reader, and whether it is answering.
 *
 * The Attendance tab calls this on mount so it can render "not set up" instead
 * of offering a scan button that cannot work.
 */
export const getStatus = async (
  req: AuthedRequest,
  res: Response,
): Promise<void> => {
  const device = activeDevice();
  try {
    const configured = device.isConfigured();
    res.json({
      configured,
      // Skipped when unconfigured: there is nothing to ping, and a probe
      // against an absent device is a guaranteed wait for a known answer.
      online: configured ? await device.isOnline() : false,
      label: device.label,
      format: device.format,
      matchesLocally: device.matchesLocally,
      enrolledCount: await prisma.fingerprintTemplate.count({
        where: { gymId: req.gymId },
      }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * Take one scan and hand back the template, without storing anything.
 *
 * The enrolment dialog calls this, then posts what it gets to `enroll` with
 * the member id. Two calls rather than one because the capture is the part
 * that fails — a finger placed badly, a reader that timed out — and separating
 * them lets the desk retry the scan without re-stating who it is for.
 *
 * Base64 out, because JSON cannot carry bytes and the client only ever passes
 * it straight back.
 */
export const capture = async (
  _req: AuthedRequest,
  res: Response,
): Promise<void> => {
  const device = activeDevice();
  if (!device.isConfigured()) {
    deviceUnavailable(res);
    return;
  }

  try {
    const result = await device.capture();
    if (!result.ok) {
      if (result.reason === "device_offline") {
        deviceUnavailable(res);
        return;
      }
      // Words the front desk can act on. "Capture failed" tells a receptionist
      // nothing; "press a little harder" tells them what to say next.
      const message: Record<string, string> = {
        no_finger: "No finger detected. Place a finger on the reader and hold it still.",
        poor_quality: "The scan was not clear enough. Wipe the reader and press a little harder.",
        timeout: "The reader timed out waiting for a finger.",
        error: "The reader could not complete the scan.",
      };
      res.status(400).json({
        error: message[result.reason] ?? "The reader could not complete the scan.",
        reason: result.reason,
      });
      return;
    }

    res.json({
      template: result.template.data.toString("base64"),
      format: result.template.format,
      quality: result.quality,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * Store a captured template against a member.
 *
 * The capture itself happens at the client, against the reader; by the time it
 * arrives here it is bytes. Re-enrolling overwrites, which is why this is an
 * upsert: a member whose finger has stopped reading well should be able to
 * enrol again at the desk without anybody deleting a row first.
 */
export const enroll = async (
  req: AuthedRequest<Record<string, string>, unknown, EnrollFingerprintBody>,
  res: Response,
): Promise<void> => {
  const { memberId, template, format, finger } = req.body;
  try {
    const member = await prisma.member.findFirst({
      where: { id: memberId, gymId: req.gymId },
      select: { id: true, name: true },
    });
    if (!member) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    const device = activeDevice();
    // A template only means something to the reader that produced it. Storing
    // one from a different make would look like a successful enrolment and
    // fail every morning afterwards, so it is refused at the point where the
    // mismatch is still explainable.
    if (device.isConfigured() && format !== device.format) {
      res.status(400).json({
        error: `That template is in ${format} format; ${device.label} reads ${device.format}. The member needs to be enrolled again on this reader.`,
      });
      return;
    }

    const bytes = Buffer.from(template, "base64");
    // Encrypted here rather than lower down: the device push below needs the
    // plaintext, and keeping both in one scope makes it visible that only the
    // sealed copy is what reaches Prisma.
    const sealed = encryptTemplate(bytes, memberId);

    const existing = await prisma.fingerprintTemplate.findUnique({
      where: { memberId },
      select: { id: true },
    });

    const record = await prisma.fingerprintTemplate.upsert({
      where: { memberId },
      create: {
        memberId,
        gymId: req.gymId,
        template: sealed,
        format,
        finger: finger ?? null,
        enrolledBy: req.actorName,
      },
      update: {
        template: sealed,
        format,
        finger: finger ?? null,
        enrolledBy: req.actorName,
        enrolledAt: new Date(),
      },
      select: { id: true, enrolledAt: true, finger: true, format: true },
    });

    // Devices that hold their own store need the same template, or the reader
    // and the database disagree about who is enrolled. Deliberately after the
    // write and outside it: a reader that rejects the push leaves a row that
    // can be re-pushed, where the reverse leaves a member the device knows and
    // the gym cannot account for.
    if (device.isConfigured() && device.matchesLocally) {
      try {
        await device.enroll(memberId, { data: bytes, format });
      } catch (err) {
        console.error("[fingerprint] device enroll failed", err);
        res.status(502).json({
          error: `Saved, but ${device.label} did not accept the fingerprint. Try enrolling again.`,
        });
        return;
      }
    }

    await audit(req, {
      action: existing ? "fingerprint.reenroll" : "fingerprint.enroll",
      entity: "Member",
      entityId: memberId,
      entityLabel: member.name,
      // The template itself is never logged. It is the one piece of biometric
      // data in the system and an audit row is the last place it should be
      // copied to.
      after: { finger: finger ?? null, format },
    });

    res.status(existing ? 200 : 201).json(record);
  } catch (err) {
    if (err instanceof BiometricCryptoError) {
      // Boot refuses to start without a usable key, so reaching this means the
      // environment changed under a running process. Worth its own message: the
      // fix is an operator's, not a receptionist's.
      console.error("[fingerprint] cannot encrypt template", err.message);
      res.status(500).json({
        error: "Fingerprints cannot be stored right now. BIOMETRIC_KEY is not usable.",
      });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

/** Remove a member's enrolment, from the database and the reader alike. */
export const remove = async (
  req: AuthedRequest<IdParam>,
  res: Response,
): Promise<void> => {
  const { id: memberId } = req.params;
  try {
    const member = await prisma.member.findFirst({
      where: { id: memberId, gymId: req.gymId },
      select: { id: true, name: true, fingerprint: { select: { id: true } } },
    });
    if (!member) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    if (!member.fingerprint) {
      res.status(404).json({ error: "That member has no fingerprint enrolled" });
      return;
    }

    await prisma.fingerprintTemplate.delete({ where: { memberId } });

    const device = activeDevice();
    if (device.isConfigured() && device.matchesLocally) {
      try {
        await device.forget(memberId);
      } catch (err) {
        // The row is gone, which is what was asked for. A reader still holding
        // the template is a real problem — it would keep letting the member in
        // — but it is not one the caller can act on, so it is logged loudly
        // rather than reported as a failed deletion.
        console.error("[fingerprint] device forget failed", err);
      }
    }

    await audit(req, {
      action: "fingerprint.remove",
      entity: "Member",
      entityId: memberId,
      entityLabel: member.name,
    });

    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * Turn whatever the reader produced into a member.
 *
 * Two request shapes, because there are two kinds of reader. A device that
 * matched internally sends the id it arrived at, and this verifies the member
 * is real and belongs to this gym — the id came from hardware on the same
 * network, which is not the same as trustworthy. A device that cannot match
 * sends a captured template, and the comparison happens here against the
 * enrolled set.
 *
 * A no-match is 404 with `matched: false` rather than an error status, because
 * an unenrolled finger on the reader is ordinary and the page needs to say so
 * plainly rather than showing a failure.
 */
export const identify = async (
  req: AuthedRequest<Record<string, string>, unknown, IdentifyFingerprintBody>,
  res: Response,
): Promise<void> => {
  const { externalId, template, format } = req.body;
  try {
    if (!externalId && !template) {
      res
        .status(400)
        .json({ error: "Send either a matched id or a captured template" });
      return;
    }

    // --- the device already knows who it is ------------------------------
    if (externalId) {
      const member = await prisma.member.findFirst({
        where: { id: externalId, gymId: req.gymId },
        select: {
          id: true,
          name: true,
          photo: true,
          photoKey: true,
          memberNo: true,
        },
      });
      // A reader holding an id this gym does not have means its store has
      // drifted from the database — a member deleted here but never forgotten
      // there. Answering "no match" is both true and the only safe reply.
      if (!member) {
        res.status(404).json({ matched: false, reason: "no_match" });
        return;
      }
      res.json({ matched: true, member: await signMemberPhoto(member) });
      return;
    }

    // --- we have to do the matching --------------------------------------
    const device = activeDevice();
    if (!device.isConfigured()) {
      deviceUnavailable(res);
      return;
    }

    const probe: Template = {
      data: Buffer.from(template!, "base64"),
      format: format ?? device.format,
    };

    // Only templates the active reader can actually read. Rows from a previous
    // device would otherwise be handed to a matcher that cannot parse them,
    // where the best case is a slow no-match and the worst is a false one.
    const enrolled = await prisma.fingerprintTemplate.findMany({
      where: { gymId: req.gymId, format: device.format },
      select: { memberId: true, template: true, format: true },
    });
    if (enrolled.length === 0) {
      res.status(404).json({ matched: false, reason: "no_enrolments" });
      return;
    }

    // A row that will not decrypt is a fault in the gym's configuration — a
    // rotated-away key, a restored backup, a tampered row — and not a member
    // failing to match. Silently dropping it from the candidate set would turn
    // that fault into an enrolled member being quietly refused at the door
    // every morning, with nothing anywhere saying why. So the first failure
    // stops the whole request.
    let candidates: { externalId: string; template: Template }[];
    try {
      candidates = enrolled.map((e) => ({
        externalId: e.memberId,
        template: {
          data: decryptTemplate(Buffer.from(e.template), e.memberId),
          format: e.format,
        },
      }));
    } catch (err) {
      if (err instanceof BiometricCryptoError) {
        console.error("[fingerprint] stored template unreadable", err.message);
        res.status(500).json({
          error:
            "Stored fingerprints could not be read. Check that BIOMETRIC_KEY " +
            "matches the one they were enrolled under.",
        });
        return;
      }
      throw err;
    }

    const result = await device.match(probe, candidates);

    if (!result.ok) {
      if (result.reason === "no_match") {
        res.status(404).json({ matched: false, reason: "no_match" });
        return;
      }
      deviceUnavailable(res);
      return;
    }

    const member = await prisma.member.findFirst({
      where: { id: result.externalId, gymId: req.gymId },
      select: {
          id: true,
          name: true,
          photo: true,
          photoKey: true,
          memberNo: true,
        },
    });
    if (!member) {
      res.status(404).json({ matched: false, reason: "no_match" });
      return;
    }

    res.json({
      matched: true,
      member: await signMemberPhoto(member),
      score: result.score,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};
