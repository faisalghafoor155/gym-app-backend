/** @format */

import type { Response } from "express";
import prisma from "../../db.js";
import { audit } from "../../services/audit.js";
import { addDays, formatMemberNo } from "../../services/membership.js";
import {
  isS3Configured,
  canStorePhotoInline,
  photoStorageUnavailable,
  uploadPhoto,
  base64ToBuffer,
  extractFilename,
} from "../../services/s3.js";
import { findDuplicateMember } from "../../services/memberDuplicate.js";
import { buildPtFeeCharge, trainerFeeSelect } from "../../services/trainerFee.js";
import { notifyWelcome } from "../../services/memberNotifications.js";
import { planErrorResponse, PlanLimitError } from "../../services/subscription.js";
import { discountFor, findUsablePromo, PromoError, redeemPromo } from "../../services/promo.js";
import type { AuthedRequest } from "../../types.js";
import type { CreateMemberBody } from "../../schemas.js";
import {
  claimMemberPlace,
  decorateWithPhoto,
  DuplicateMemberError,
  memberFields,
  respondDuplicate,
  selectMember,
  UnknownTrainerError,
} from "./shared.js";

/** Thrown when the referrer named does not belong to this gym. */
class UnknownReferrerError extends Error {}

/**
 * Registers a member, optionally selling them a membership in the same breath
 * — which is what actually happens at the front desk when somebody walks in.
 *
 * The member number and, when a plan is given, the whole membership are
 * created in one transaction: a member numbered from a counter that then fails
 * to save would burn that number, and a half-registered member is worse than a
 * rejected one.
 */

export const create = async (
  req: AuthedRequest<Record<string, string>, unknown, CreateMemberBody>,
  res: Response,
): Promise<void> => {
  // `ptFee`/`ptFeePaid` and the `fee*` group are pulled out with the rest: they
  // price and settle money taken at the counter and are not columns on the
  // member, so they must not reach the create below.
  const {
    planId,
    startDate,
    photo,
    ptFee,
    ptFeePaid,
    feeAmount,
    feeMethod,
    feeChannel,
    feeReference,
    referredById,
    promoCode,
    ...fields
  } = req.body;
  try {
    if (planId) {
      const plan = await prisma.membershipPlan.findFirst({
        where: { id: planId, gymId: req.gymId },
      });
      if (!plan) {
        res.status(404).json({ error: "Membership plan not found" });
        return;
      }
      if (!plan.isActive) {
        res
          .status(400)
          .json({ error: "That membership plan is no longer offered" });
        return;
      }
    }

    // Handle photo upload to S3 before creating member.
    //
    // Only the key is kept. The bucket is private, so there is no URL worth
    // storing — one is signed per response instead.
    let photoData: { photo?: string; photoKey?: string } = {};
    if (photo && isS3Configured()) {
      try {
        // Generate a temporary ID for the filename
        const tempId = `new-${Date.now()}`;
        const buffer = base64ToBuffer(photo);
        const filename = extractFilename(photo, `member-${tempId}`);
        const { key } = await uploadPhoto(buffer, filename, tempId);
        photoData = { photoKey: key };
      } catch (uploadError) {
        console.error("Photo upload failed:", uploadError);
        res.status(400).json({ error: "Failed to upload photo" });
        return;
      }
    } else if (photo && canStorePhotoInline()) {
      // Development only — see `canStorePhotoInline`. In production this branch
      // is closed and the request is refused below rather than quietly writing
      // a couple of megabytes of base64 onto the row.
      photoData = { photo };
    } else if (photo) {
      res.status(503).json({ error: photoStorageUnavailable });
      return;
    }

    const member = await prisma.$transaction(async (tx) => {
      // The gym's plan allows only so many people on the books. Claimed before
      // anything is written, and inside the transaction, so a refusal rolls
      // back the whole registration rather than leaving a member number burnt.
      await claimMemberPlace(tx, req.gymId);

      // Re-checked here rather than trusting the client's live check: that one
      // is a hint typed into a form, this one is the decision. Two receptionists
      // registering the same walk-in at once both pass the hint; only one gets
      // past this.
      const duplicate = await findDuplicateMember(tx, req.gymId, fields);
      if (duplicate) throw new DuplicateMemberError(duplicate);

      // Incrementing and reading back in one statement is what makes two
      // receptionists adding members at the same moment safe.
      const gym = await tx.gym.update({
        where: { id: req.gymId },
        data: { memberSeq: { increment: 1 } },
        select: { memberSeq: true, defaultPtFee: true, referralRewardDays: true },
      });

      // Scoped by gym: a member id from elsewhere must not become a referrer
      // here and earn a reward from a gym they do not belong to.
      if (referredById) {
        const referrer = await tx.member.findFirst({
          where: { id: referredById, gymId: req.gymId },
          select: { id: true },
        });
        if (!referrer) throw new UnknownReferrerError();
      }

      const created = await tx.member.create({
        data: {
          gymId: req.gymId,
          memberNo: formatMemberNo(gym.memberSeq),
          ...fields,
          ...photoData,
          referredById: referredById ?? null,
        },
        select: memberFields,
      });

      // The reward is decided now, at the gym's current rate, and granted
      // later by somebody at the desk — see the referrals controller.
      if (referredById) {
        await tx.referralReward.create({
          data: {
            gymId: req.gymId,
            referrerId: referredById,
            referredId: created.id,
            rewardDays: gym.referralRewardDays,
          },
        });
      }

      let membershipId: string | null = null;
      if (planId) {
        const plan = await tx.membershipPlan.findUniqueOrThrow({
          where: { id: planId },
        });
        // The code decides the price, here, inside the sale — never a
        // figure the desk typed.
        const promo = promoCode
          ? await findUsablePromo(tx, req.gymId, promoCode)
          : null;
        const listPrice = plan.price.toNumber();
        const discount = promo ? discountFor(promo, listPrice) : 0;
        const start = startDate ?? new Date();
        const expiry = addDays(start, plan.durationDays);

        const membership = await tx.membership.create({
          data: {
            gymId: req.gymId,
            memberId: created.id,
            planId: plan.id,
            startDate: start,
            expiryDate: expiry,
            pricePaid: listPrice - discount,
          },
          select: { id: true },
        });
        membershipId = membership.id;
        if (promo) {
          await redeemPromo(tx, promo, {
            gymId: req.gymId, memberId: created.id, membershipId, discount,
          });
        }
      }

      // The fee handed over at the counter, when one was. Linked to the
      // membership it bought where there is one — that link is what turns "this
      // member paid Rs. 2500" into books that reconcile.
      if (feeAmount != null && feeAmount > 0) {
        const method = feeMethod ?? "cash";
        await tx.payment.create({
          data: {
            gymId: req.gymId,
            memberId: created.id,
            amount: feeAmount,
            method,
            // Cash never carries a wallet's name, whatever the form sent.
            channel: method === "cash" ? null : feeChannel ?? null,
            reference: feeReference ?? null,
            status: "paid",
            type: membershipId ? "membership" : "other",
            membershipId,
            recordedById: req.userId,
            notes: membershipId ? "Joining fee" : "Joining fee (no plan)",
          },
        });
      }

      if (fields.trainerId) {
        const trainer = await tx.trainer.findFirst({
          // Scoped by gym: a trainer id from elsewhere must not resolve here
          // and put another gym's name on this member's bill.
          //
          // Active only, matching PT sessions and class schedules: somebody
          // who has left the gym cannot be given a new member, and a fee
          // charged in their name is money owed to nobody.
          where: { id: fields.trainerId, gymId: req.gymId, isActive: true },
          select: trainerFeeSelect,
        });
        // Refused rather than ignored, same as on edit: the member row was
        // written a moment ago carrying this trainer, so letting the lookup
        // miss quietly would register them onto a trainer who has left, with
        // no fee raised for it. Throwing rolls the whole registration back.
        if (!trainer) throw new UnknownTrainerError();
        {
          const charge = buildPtFeeCharge(
            req.gymId,
            created.id,
            trainer,
            { defaultPtFee: gym.defaultPtFee },
            {
              override: ptFee,
              paid: ptFeePaid,
              recordedById: req.userId,
              // The member paid for the whole registration one way; the
              // trainer fee took the same route.
              method: feeMethod,
              channel: feeChannel,
              reference: feeReference,
            },
          );
          if (charge) await tx.payment.create({ data: charge });
        }
      }

      return created;
    });

    const full = await prisma.member.findUniqueOrThrow({
      where: { id: member.id },
      select: selectMember,
    });
    const view = await decorateWithPhoto(full);

    await audit(req, {
      action: "member.create",
      entity: "member",
      entityId: member.id,
      entityLabel: `${member.memberNo} · ${member.name}`,
      after: { ...member, membership: view.currentMembership },
    });

    // Not awaited, and its failure is swallowed inside: registering somebody
    // must not depend on Meta being reachable, and the desk is standing in
    // front of the member either way. The member number is the payload that
    // matters — it is what they will be asked for, and this is their only
    // copy of it.
    void notifyWelcome(req.gymId, full);

    res.status(201).json(view);
  } catch (err) {
    if (err instanceof DuplicateMemberError) {
      respondDuplicate(res, err.hit);
      return;
    }
    if (err instanceof PlanLimitError) {
      // Says how to make room as well as how to buy it: this limit counts
      // active members, so a gym at its ceiling can free a place by retiring
      // somebody who stopped coming rather than by paying.
      const { status, body } = planErrorResponse(err);
      res.status(status).json({
        ...body,
        error: `${body.error as string} Set a lapsed member to inactive to free a place.`,
      });
      return;
    }
    if (err instanceof UnknownTrainerError) {
      res.status(404).json({ error: "Trainer not found" });
      return;
    }
    if (err instanceof UnknownReferrerError) {
      res.status(404).json({ error: "Referring member not found" });
      return;
    }
    if (err instanceof PromoError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};
