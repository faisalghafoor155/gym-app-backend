import type { Response } from 'express';
import type { MemberMeasurement } from '@prisma/client';
import prisma from '../db.js';
import { audit } from '../services/audit.js';
import { withMoney } from '../services/money.js';
import {
  base64ToBuffer,
  canStorePhotoInline,
  deletePhoto,
  extractFilename,
  getPhotoUrl,
  isS3Configured,
  photoStorageUnavailable,
  uploadPhoto,
} from '../services/s3.js';
import type { AuthedRequest } from '../types.js';
import type { CreateMeasurementBody, IdParam, MeasurementParams } from '../schemas.js';

/**
 * A member's weigh-ins, read and written from two places: the staff side,
 * where the member is named in the URL, and the member's own portal, where
 * the member is whoever is signed in.
 *
 * Both routes come down to the same three operations on (gym, member), so
 * the work lives in one set of functions and each route only decides whose
 * record it is.
 */

/** The numeric columns, which are Decimal in the database and numbers on the
 *  wire. Listed once so a column added later cannot leave as a string. */
const MEASURES = [
  'weightKg', 'bodyFatPct', 'chestCm', 'waistCm', 'hipsCm', 'armCm', 'thighCm',
] as const;

/**
 * Enough rows to chart years of weekly weigh-ins. A ceiling rather than paging:
 * the portal draws a trend from the whole history, and a trend drawn from the
 * newest page alone would start wherever the page happened to end.
 */
const HISTORY_LIMIT = 500;

/** One row as the API returns it: numbers, a signed photo, no storage key. */
const toView = async (
  row: MemberMeasurement & { recordedBy?: { id: string; name: string } | null },
) => {
  const { photoKey, photo, ...rest } = withMoney(row, ...MEASURES);
  return {
    ...rest,
    // Signed for this response, exactly as a member's face is. The key stays
    // server-side for the same reason.
    photo: photo ?? (await getPhotoUrl(photoKey)),
  };
};

const listFor = async (gymId: string, memberId: string) => {
  const rows = await prisma.memberMeasurement.findMany({
    where: { gymId, memberId },
    include: { recordedBy: { select: { id: true, name: true } } },
    // Newest first, like every other history in the app. The chart sorts its
    // own copy oldest-first.
    orderBy: [{ measuredOn: 'desc' }, { createdAt: 'desc' }],
    take: HISTORY_LIMIT,
  });
  return Promise.all(rows.map(toView));
};

/** Thrown when a photo was sent but there is nowhere to keep it. */
class PhotoStorageError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Puts a progress photo wherever this install keeps photos. */
const storePhoto = async (
  photo: string | null | undefined,
  memberId: string,
): Promise<{ photo?: string; photoKey?: string }> => {
  if (!photo) return {};
  if (isS3Configured()) {
    try {
      const buffer = base64ToBuffer(photo);
      const { key } = await uploadPhoto(
        buffer,
        extractFilename(photo, `progress-${Date.now()}`),
        memberId,
      );
      return { photoKey: key };
    } catch (err) {
      console.error('Progress photo upload failed:', err);
      throw new PhotoStorageError(400, 'Failed to upload photo');
    }
  }
  if (canStorePhotoInline()) return { photo };
  throw new PhotoStorageError(503, photoStorageUnavailable);
};

const createFor = async (
  req: AuthedRequest<Record<string, string>, unknown, CreateMeasurementBody>,
  res: Response,
  member: { id: string; name: string; memberNo: string },
): Promise<void> => {
  const { measuredOn, photo, notes, ...measures } = req.body;
  try {
    const stored = await storePhoto(photo, member.id);

    const row = await prisma.memberMeasurement.create({
      data: {
        gymId: req.gymId,
        memberId: member.id,
        measuredOn: measuredOn ?? new Date(),
        ...measures,
        ...stored,
        notes: notes ?? null,
        recordedById: req.userId,
      },
      include: { recordedBy: { select: { id: true, name: true } } },
    });

    await audit(req, {
      action: 'measurement.create',
      entity: 'measurement',
      entityId: row.id,
      entityLabel: `${member.memberNo} · ${member.name}`,
      after: { measuredOn: row.measuredOn, ...measures, photo: Boolean(photo) },
    });

    res.status(201).json(await toView(row));
  } catch (err) {
    if (err instanceof PhotoStorageError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

const removeFor = async (
  req: AuthedRequest<unknown>,
  res: Response,
  member: { id: string; name: string; memberNo: string },
  measurementId: string,
  /** Set for a member removing their own: they may only take back what they
   *  entered, not a trainer's record of them. */
  onlyRecordedBy?: string,
): Promise<void> => {
  try {
    const row = await prisma.memberMeasurement.findFirst({
      where: { id: measurementId, gymId: req.gymId, memberId: member.id },
    });
    if (!row) {
      res.status(404).json({ error: 'Measurement not found' });
      return;
    }
    if (onlyRecordedBy && row.recordedById !== onlyRecordedBy) {
      res.status(403).json({ error: 'Only the gym can remove a measurement it recorded' });
      return;
    }

    await prisma.memberMeasurement.delete({ where: { id: row.id } });
    // After the row is gone, never before: a failed delete must not leave a
    // record pointing at a photo that no longer exists.
    if (row.photoKey) await deletePhoto(row.photoKey);

    await audit(req, {
      action: 'measurement.delete',
      entity: 'measurement',
      entityId: row.id,
      entityLabel: `${member.memberNo} · ${member.name}`,
      // The whole row, not a diff — after a delete the log is the only record
      // left. Decimals are turned into numbers by the audit writer.
      before: {
        measuredOn: row.measuredOn,
        ...Object.fromEntries(MEASURES.map(k => [k, row[k]])),
        photo: Boolean(row.photoKey ?? row.photo),
      },
    });

    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// --- staff: the member is named in the URL --------------------------------

/** Scoped by gym, so another gym's member id reads as missing. */
const findMember = (gymId: string, id: string) =>
  prisma.member.findFirst({
    where: { id, gymId },
    select: { id: true, name: true, memberNo: true },
  });

export const listForMember = async (
  req: AuthedRequest<IdParam>,
  res: Response,
): Promise<void> => {
  try {
    const member = await findMember(req.gymId, req.params.id);
    if (!member) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    res.json({ data: await listFor(req.gymId, member.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const createForMember = async (
  req: AuthedRequest<IdParam, unknown, CreateMeasurementBody>,
  res: Response,
): Promise<void> => {
  const member = await findMember(req.gymId, req.params.id).catch(() => null);
  if (!member) {
    res.status(404).json({ error: 'Member not found' });
    return;
  }
  await createFor(req as never, res, member);
};

export const removeForMember = async (
  req: AuthedRequest<MeasurementParams>,
  res: Response,
): Promise<void> => {
  const member = await findMember(req.gymId, req.params.id).catch(() => null);
  if (!member) {
    res.status(404).json({ error: 'Member not found' });
    return;
  }
  await removeFor(req, res, member, req.params.measurementId);
};

// --- member: the member is whoever is signed in ---------------------------

/** The session's own member record, or a 404 that says why there is none. */
const findSelf = async (req: AuthedRequest<unknown>, res: Response) => {
  if (!req.memberId) {
    res.status(404).json({ error: 'This account is not linked to a member record' });
    return null;
  }
  const member = await findMember(req.gymId, req.memberId).catch(() => null);
  if (!member) {
    res.status(404).json({ error: 'Member record not found' });
    return null;
  }
  return member;
};

export const listMine = async (req: AuthedRequest, res: Response): Promise<void> => {
  const member = await findSelf(req, res);
  if (!member) return;
  try {
    res.json({ data: await listFor(req.gymId, member.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

export const createMine = async (
  req: AuthedRequest<Record<string, string>, unknown, CreateMeasurementBody>,
  res: Response,
): Promise<void> => {
  const member = await findSelf(req, res);
  if (!member) return;
  await createFor(req, res, member);
};

export const removeMine = async (
  req: AuthedRequest<IdParam>,
  res: Response,
): Promise<void> => {
  const member = await findSelf(req, res);
  if (!member) return;
  await removeFor(req, res, member, req.params.id, req.userId);
};
