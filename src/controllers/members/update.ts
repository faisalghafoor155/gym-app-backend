/** @format */

import type { Response } from "express";
import prisma from "../../db.js";
import { audit, diff } from "../../services/audit.js";
import {
  canStorePhotoInline,
  photoStorageUnavailable,
  isS3Configured,
  uploadPhoto,
  deletePhoto,
  base64ToBuffer,
  extractFilename,
} from "../../services/s3.js";
import { findDuplicateMember } from "../../services/memberDuplicate.js";
import { buildPtFeeCharge, trainerFeeSelect } from "../../services/trainerFee.js";
import type { AuthedRequest } from "../../types.js";
import type { IdParam, UpdateMemberBody } from "../../schemas.js";
import {
  decorateWithPhoto,
  DuplicateMemberError,
  memberFields,
  respondDuplicate,
  selectMember,
  UnknownTrainerError,
} from "./shared.js";

/** Fields worth recording a change to. Photos are excluded — "photo changed"
 *  is noise, and the data-URL itself must never reach an audit row. */
const AUDITED_MEMBER_FIELDS = [
  "name",
  "email",
  "phone",
  "gender",
  "dateOfBirth",
  "address",
  "emergencyContact",
  // A member's stated wish about being messaged. Worth a row of its own: if
  // somebody is later messaged after opting out, the question is who changed
  // it back and when.
  "whatsappOptOut",
  "status",
] as const;

export const update = async (
  req: AuthedRequest<IdParam, unknown, UpdateMemberBody>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  const {
    name,
    email,
    phone,
    photo,
    gender,
    dateOfBirth,
    address,
    emergencyContact,
    whatsappOptOut,
    trainerId,
    ptFee,
    ptFeePaid,
  } = req.body;
  try {
    const existing = await prisma.member.findFirst({
      where: { id, gymId: req.gymId },
      select: memberFields,
    });
    if (!existing) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    let photoData: {
      photo?: string | null;
      photoKey?: string | null;
    } = {};

    // Handle photo upload to S3 if provided and S3 is configured
    if (photo !== undefined) {
      if (photo === null) {
        // Delete existing photo
        if (existing.photoKey) {
          await deletePhoto(existing.photoKey);
        }
        photoData = { photo: null, photoKey: null };
      } else if (photo && isS3Configured()) {
        // Upload new photo to S3
        try {
          const buffer = base64ToBuffer(photo);
          const filename = extractFilename(photo, `member-${id}`);
          const { key } = await uploadPhoto(buffer, filename, id);

          // Delete old photo if exists
          if (existing.photoKey) {
            await deletePhoto(existing.photoKey);
          }

          photoData = { photo: null, photoKey: key };
        } catch (uploadError) {
          console.error("Photo upload failed:", uploadError);
          res.status(400).json({ error: "Failed to upload photo" });
          return;
        }
      } else if (photo && canStorePhotoInline()) {
        // Development only — see `canStorePhotoInline`.
        photoData = { photo };
      } else if (photo) {
        // Refused rather than stored inline. Nothing has been written yet, so
        // the member keeps the photo they already had.
        res.status(503).json({ error: photoStorageUnavailable });
        return;
      }
    }

    await prisma.$transaction(async (tx) => {
      // An edit is checked against what the member will be, not what was
      // typed: leaving the phone alone and changing the name still has to be
      // compared using the phone already on file. `undefined` means "not
      // sent", so it falls back to the stored value.
      const duplicate = await findDuplicateMember(
        tx,
        req.gymId,
        {
          name: name ?? existing.name,
          phone: phone === undefined ? existing.phone : phone,
          dateOfBirth:
            dateOfBirth === undefined ? existing.dateOfBirth : dateOfBirth,
        },
        // Without this a member duplicates itself the moment it is re-saved.
        id,
      );
      if (duplicate) throw new DuplicateMemberError(duplicate);

      // Charged when the member moves onto a trainer they were not already
      // with — including a switch between trainers, since that is a new
      // engagement with a fee of its own.
      if (trainerId && trainerId !== existing.trainerId) {
        const [trainer, gym] = await Promise.all([
          tx.trainer.findFirst({
            // Active only, matching PT sessions and class schedules: a trainer
            // who has left cannot take on a new member.
            where: { id: trainerId, gymId: req.gymId, isActive: true },
            select: trainerFeeSelect,
          }),
          tx.gym.findUniqueOrThrow({
            where: { id: req.gymId },
            select: { defaultPtFee: true },
          }),
        ]);
        // Refused rather than ignored. The fee lookup and the assignment are
        // two writes, and letting the first fail quietly put the member on a
        // trainer with no fee raised at all — the one outcome nobody chose.
        if (!trainer) throw new UnknownTrainerError();

        const charge = buildPtFeeCharge(req.gymId, id, trainer, gym, {
          override: ptFee,
          paid: ptFeePaid,
          recordedById: req.userId,
        });
        if (charge) await tx.payment.create({ data: charge });
      }

      await tx.member.update({
        where: { id },
        data: {
          ...(name && { name }),
          ...(email !== undefined && { email }),
          ...(phone !== undefined && { phone }),
          ...photoData,
          ...(gender !== undefined && { gender }),
          ...(dateOfBirth !== undefined && { dateOfBirth }),
          ...(address !== undefined && { address }),
          ...(emergencyContact !== undefined && { emergencyContact }),
          ...(whatsappOptOut !== undefined && { whatsappOptOut }),
          ...(trainerId !== undefined && { trainerId }),
        },
      });
    });

    const full = await prisma.member.findUniqueOrThrow({
      where: { id },
      select: selectMember,
    });

    // A save that changed nothing should not leave an entry claiming it did.
    const changed = diff(existing, full, AUDITED_MEMBER_FIELDS);
    if (changed) {
      await audit(req, {
        action: "member.update",
        entity: "member",
        entityId: id,
        entityLabel: `${existing.memberNo} · ${full.name}`,
        ...changed,
      });
    }

    res.json(await decorateWithPhoto(full));
  } catch (err) {
    if (err instanceof DuplicateMemberError) {
      respondDuplicate(res, err.hit);
      return;
    }
    if (err instanceof UnknownTrainerError) {
      res.status(404).json({ error: "Trainer not found" });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};
