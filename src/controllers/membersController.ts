/** @format */

import type { Response } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { audit, diff } from "../services/audit.js";
import {
  addDays,
  currentMembershipWhere,
  effectiveMemberStatus,
  formatMemberNo,
  memberStatusWhere,
  toView,
  withPlan,
} from "../services/membership.js";
import {
  isS3Configured,
  canStorePhotoInline,
  photoStorageUnavailable,
  uploadPhoto,
  deletePhoto,
  getPhotoUrl,
  base64ToBuffer,
  extractFilename,
} from "../services/s3.js";
import {
  duplicateMessage,
  findDuplicateMember,
  normalizeName,
  normalizePhone,
  type DuplicateHit,
} from "../services/memberDuplicate.js";
import { buildPtFeeCharge, trainerFeeSelect } from "../services/trainerFee.js";
import { notifyWelcome } from "../services/memberNotifications.js";
import {
  claimPlace,
  planErrorResponse,
  PlanLimitError,
} from "../services/subscription.js";
import type { AuthedRequest } from "../types.js";
import type {
  CreateMemberBody,
  UpdateMemberBody,
  IdParam,
  MemberQuery,
  MemberDuplicateQuery,
  MemberStatusFilter,
} from "../schemas.js";

const memberFields = {
  id: true,
  gymId: true,
  memberNo: true,
  name: true,
  email: true,
  phone: true,
  photo: true,
  photoKey: true,
  // `photoUrl` is deliberately not selected. It held a permanent public S3 link
  // back when the bucket was world-readable; it is now dead, and returning a
  // stale one would hand out exactly the link this change exists to stop
  // issuing. The URL clients get is signed per response from `photoKey`.
  gender: true,
  dateOfBirth: true,
  address: true,
  emergencyContact: true,
  whatsappOptOut: true,
  status: true,
  createdAt: true,
  trainerId: true,
  trainer: { select: { id: true, name: true, ptFee: true } },
  /**
   * The member's fingerprint enrolment, minus the template itself.
   *
   * Deliberately not `true`: that would put every enrolled member's biometric
   * on the wire on every page of the roster. The list only needs to know
   * whether there is one and when it was taken, so that is all it is given.
   */
  fingerprint: {
    select: { id: true, enrolledAt: true, finger: true, format: true },
  },
} as const;

/**
 * A member's current membership is the newest one that has not been replaced
 * or called off. Pulled as a one-element list so a member without one comes
 * back as an empty array rather than a failed join.
 */
const currentMembership = {
  where: currentMembershipWhere,
  orderBy: { createdAt: "desc" },
  take: 1,
  include: withPlan,
} as const;

type MemberRow = Prisma.MemberGetPayload<{
  select: typeof memberFields & { memberships: typeof currentMembership };
}>;

/**
 * Flattens the one-element memberships list into the single field the API
 * promises, so clients never deal with the query's shape.
 *
 * `status` is overwritten with the effective one: a member whose membership
 * lapsed two months ago reads as `inactive` without anything having been
 * written to their row. `storedStatus` is kept alongside so a client can still
 * tell a hand-deactivated member from one the calendar retired.
 */
const decorate = (
  { memberships, ...member }: MemberRow,
  now: Date = new Date(),
) => {
  const current = memberships[0] ?? null;
  return {
    ...member,
    status: effectiveMemberStatus(member.status, current, now),
    storedStatus: member.status,
    currentMembership: current ? toView(current, now) : null,
  };
};

/**
 * `decorate`, plus a freshly signed photo URL.
 *
 * The bucket is private, so a photo is only ever reachable through a signature
 * minted for this response and valid for minutes. `photoKey` is the durable
 * thing on the row; the URL is derived, never stored — see services/s3.ts for
 * why that reversal matters.
 *
 * The signed URL is served as `photo`, which is the field the clients already
 * render, so nothing on the front end has to know whether a face came from S3
 * or from the legacy inline base64 column.
 *
 * `photoKey` is stripped on the way out. It is the one input a URL is built
 * from, so handing it to a client hands over the ingredient for exactly the
 * unauthenticated link this change stopped issuing — and no client has any use
 * for it, since the only thing it can be turned into is served here already.
 */
const decorateWithPhoto = async (
  row: MemberRow,
  now: Date = new Date(),
): Promise<Omit<ReturnType<typeof decorate>, "photoKey">> => {
  const { photoKey, ...member } = decorate(row, now);
  return {
    ...member,
    // A legacy inline base64 photo is already a usable src and needs no signing.
    photo: member.photo ?? (await getPhotoUrl(photoKey)),
  };
};

/** The same, for a page of members. */
const decorateAllWithPhotos = async (
  rows: readonly MemberRow[],
  now: Date = new Date(),
): Promise<Omit<ReturnType<typeof decorate>, "photoKey">[]> =>
  Promise.all(rows.map((r) => decorateWithPhoto(r, now)));

const selectMember = {
  ...memberFields,
  memberships: currentMembership,
} as const;

/**
 * The same row without the photo, for the `all=true` pickers.
 *
 * Photos are base64 data-URLs of up to 2MB living inline on the row, so they
 * are the entire reason a full member list is expensive. A dropdown renders a
 * name, never a face, so leaving them out is what makes returning every member
 * affordable at all.
 *
 * `photoKey` goes with it — a picker that shows no face has no use for the key
 * to one, and it is not a value to hand out for free.
 */
const selectMemberLite = (() => {
  const { photo: _photo, photoKey: _photoKey, ...rest } = memberFields;
  return { ...rest, memberships: currentMembership } as const;
})();

/**
 * The roster, newest first.
 *
 * Paged by default. Search and the status tabs are applied here rather than in
 * the browser: a client that filters what it was given can only ever search the
 * page it is holding, which turns a search box into a lie the moment the gym
 * outgrows one page.
 *
 * `all=true` opts out for the pickers that need every member — see the query
 * schema. That response drops photos and is still a single query, so the cost
 * is a name-sized row per member rather than a photo-sized one.
 */
export const getAll = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, MemberQuery>,
  res: Response,
): Promise<void> => {
  const { search, status, gender, trainerId, page, limit, all } = req.query;
  try {
    // One clock for the whole request, so the rows, the filter boundaries and
    // the count can never disagree about what "today" was.
    const now = new Date();

    const where = {
      gymId: req.gymId,
      // Applies to every view of the roster, paged or not — a filtered list
      // that quietly went back to everyone on the next page would be worse
      // than no filter.
      ...(gender && { gender }),
      // `none` asks for the members nobody has been given, which is a real
      // question — it is the list a gym works through when handing them out —
      // and is not the same as not filtering at all.
      ...(trainerId && { trainerId: trainerId === "none" ? null : trainerId }),
      // Whatever the front desk has to hand: a name, a number, or a phone.
      ...(search && {
        OR: [
          { name: { contains: search, mode: "insensitive" as const } },
          { memberNo: { contains: search, mode: "insensitive" as const } },
          { phone: { contains: search, mode: "insensitive" as const } },
        ],
      }),
      // No tab chosen means "everyone still on the books", which excludes the
      // lapsed: somebody who stopped coming two months ago is reachable from
      // their own tab rather than cluttering the default list.
      //
      // Two things override that. A search, because someone typing a name wants
      // that person found and a box that silently refuses to return them reads
      // as broken search rather than as a filter. And `all`, because a picker
      // asking for every member means every member — a lapsed one is exactly
      // who the front desk is about to sell a renewal to.
      ...(status
        ? memberStatusWhere(status, now)
        : search || all
          ? {}
          : { NOT: memberStatusWhere("lapsed", now) }),
    };

    if (all) {
      const members = await prisma.member.findMany({
        where,
        select: selectMemberLite,
        orderBy: { createdAt: "desc" },
      });
      // Same envelope as the paged response, so a caller never has to branch on
      // the shape of what came back — only `hasMore` differs, and it cannot be
      // true here by definition.
      res.json({
        // No face and no key: a picker renders a name, and neither is fetched.
        data: members.map((m) =>
          decorate({ ...m, photo: null, photoKey: null }, now),
        ),
        total: members.length,
        page: 1,
        limit: members.length,
        hasMore: false,
      });
      return;
    }

    // The tab counts, which have to cover the whole roster rather than the page
    // — a tab labelled with what happens to be on screen is worse than one with
    // no number at all. Each is the same predicate the tab itself filters by, so
    // clicking a tab showing 12 always lands on 12 people.
    //
    // Counted against `searchWhere` rather than `where`: the tabs must keep
    // narrowing the current search, but must not narrow themselves by the tab
    // already selected, which would leave every other tab reading zero.
    // Carries the gender too: with it left out, the tabs would count the whole
    // gym while the list below showed one half, and clicking a tab reading 40
    // would land on 18.
    const searchWhere = {
      gymId: req.gymId,
      ...(gender && { gender }),
      ...(trainerId && { trainerId: trainerId === "none" ? null : trainerId }),
      ...(where.OR && { OR: where.OR }),
    };
    const countFor = (f: MemberStatusFilter) =>
      prisma.member.count({
        where: { ...searchWhere, ...memberStatusWhere(f, now) },
      });

    const [members, total, active, expiring, expired, lapsed, none] =
      await Promise.all([
        prisma.member.findMany({
          where,
          select: selectMember,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.member.count({ where }),
        countFor("active"),
        countFor("expiring"),
        countFor("expired"),
        countFor("lapsed"),
        countFor("none"),
      ]);

    res.json({
      data: await decorateAllWithPhotos(members, now),
      total,
      page,
      limit,
      hasMore: page * limit < total,
      // "All" means everyone still on the books, which is everybody except the
      // lapsed — the same rule the page's All tab applies.
      counts: {
        all: active + expiring + expired + none,
        active,
        expiring,
        expired,
        lapsed,
        none,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

export const getOne = async (
  req: AuthedRequest<IdParam>,
  res: Response,
): Promise<void> => {
  try {
    const member = await prisma.member.findFirst({
      where: { id: req.params.id, gymId: req.gymId },
      select: selectMember,
    });
    if (!member) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    res.json(await decorateWithPhoto(member));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * Raised inside a transaction when the member being written duplicates one
 * that already exists. Thrown rather than returned so the transaction rolls
 * back — a duplicate detected after the gym's member counter was incremented
 * must not leave that number spent.
 */
class DuplicateMemberError extends Error {
  constructor(readonly hit: DuplicateHit) {
    super(duplicateMessage(hit));
    this.name = "DuplicateMemberError";
  }
}

/**
 * A trainer named on an edit that this gym does not have, or no longer has.
 *
 * Thrown so the transaction rolls back: the fee lookup and the assignment are
 * separate writes, and a lookup that failed quietly left the member on a
 * trainer with no fee raised against them.
 */
class UnknownTrainerError extends Error {
  constructor() {
    super("Trainer not found");
    this.name = "UnknownTrainerError";
  }
}

/** The 409 both create and update answer a duplicate with. */
const respondDuplicate = (res: Response, hit: DuplicateHit): void => {
  res
    .status(409)
    .json({ error: duplicateMessage(hit), field: hit.field, existing: hit.existing });
};

/**
 * Registers a member, optionally selling them a membership in the same breath
 * — which is what actually happens at the front desk when somebody walks in.
 *
 * The member number and, when a plan is given, the whole membership are
 * created in one transaction: a member numbered from a counter that then fails
 * to save would burn that number, and a half-registered member is worse than a
 * rejected one.
 */
/**
 * Claims one place on the gym's roster, against its plan's member limit.
 *
 * Counts active members only, which is what makes the limit escapable without
 * losing anybody: a gym at its ceiling can mark the people who stopped coming
 * inactive and carry on, rather than having to delete them. It also stops a
 * five-year-old gym being pushed up a tier by members from its first year.
 *
 * The lock inside `claimPlace` is what makes it hold under load — two
 * receptionists registering the 50th and 51st walk-in at the same moment
 * otherwise both count 49 and both commit.
 */
const claimMemberPlace = (tx: Prisma.TransactionClient, gymId: string): Promise<void> =>
  claimPlace(tx, gymId, "members", (t) =>
    t.member.count({ where: { gymId, status: "active" } }),
  );

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
        select: { memberSeq: true, defaultPtFee: true },
      });

      const created = await tx.member.create({
        data: {
          gymId: req.gymId,
          memberNo: formatMemberNo(gym.memberSeq),
          ...fields,
          ...photoData,
        },
        select: memberFields,
      });

      let membershipId: string | null = null;
      if (planId) {
        const plan = await tx.membershipPlan.findUniqueOrThrow({
          where: { id: planId },
        });
        const start = startDate ?? new Date();
        const expiry = addDays(start, plan.durationDays);

        const membership = await tx.membership.create({
          data: {
            gymId: req.gymId,
            memberId: created.id,
            planId: plan.id,
            startDate: start,
            expiryDate: expiry,
            pricePaid: plan.price,
          },
          select: { id: true },
        });
        membershipId = membership.id;
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
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

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

/**
 * Answers "would this person be a duplicate?" without writing anything.
 *
 * The add-member form asks as fields are filled, so the front desk finds out
 * before typing the rest of the form rather than after pressing Save. It is
 * only a hint: the create and update paths check again for themselves, and
 * this endpoint failing is not allowed to stop a registration.
 */
export const checkDuplicate = async (
  req: AuthedRequest<Record<string, string>, unknown, unknown, MemberDuplicateQuery>,
  res: Response,
): Promise<void> => {
  const { name, phone, dateOfBirth, excludeId } = req.query;
  try {
    const hit = await findDuplicateMember(
      prisma,
      req.gymId,
      { name, phone, dateOfBirth },
      excludeId,
    );
    res.json(
      hit
        ? {
            duplicate: true,
            field: hit.field,
            existing: hit.existing,
            message: duplicateMessage(hit),
          }
        : { duplicate: false },
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

const parseCsvLine = (line: string): string[] => {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);
  return values.map((value) => value.trim());
};

export const importMembers = async (
  req: AuthedRequest<Record<string, string>, unknown, { csv: string }>,
  res: Response,
): Promise<void> => {
  const { csv } = req.body;

  try {
    const rows = csv
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (rows.length < 2) {
      res.status(400).json({
        error: "CSV must include a header row and at least one member row",
      });
      return;
    }

    const header = parseCsvLine(rows[0]);
    const expected = [
      "name",
      "email",
      "phone",
      "gender",
      "dateOfBirth",
      "address",
      "emergencyContact",
    ];
    const index = new Map(header.map((name, idx) => [name.toLowerCase(), idx]));

    const missing = expected.filter((key) => !index.has(key));
    if (missing.length > 0 && missing.length < expected.length) {
      // allow a minimal CSV with just name and optional contact fields
    }

    interface ImportedMemberData {
      name: string;
      email?: string;
      phone?: string;
      gender?: string;
      dateOfBirth?: string;
      address?: string;
      emergencyContact?: string;
    }

    const createData: ImportedMemberData[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();

    for (let i = 1; i < rows.length; i++) {
      const values = parseCsvLine(rows[i]);
      const row: Record<string, string> = {};
      for (const [key, idx] of index.entries()) {
        row[key] = values[idx] ?? "";
      }

      const name = (row.name ?? "").trim();
      if (!name) {
        errors.push(`Row ${i + 1}: name is required`);
        continue;
      }

      const email = (row.email ?? "").trim();
      const phone = (row.phone ?? "").trim();
      const dateOfBirth = (row.dateOfBirth ?? "").trim();

      // The same rules the form is held to, applied within the file as well:
      // a CSV that lists one person twice is the commonest way a duplicate
      // gets in, and neither row exists in the database yet to catch it.
      const normalizedPhone = normalizePhone(phone);
      const normalizedName = normalizeName(name);
      const rowKeys = [
        ...(normalizedPhone ? [`phone:${normalizedPhone}`] : []),
        ...(normalizedName && dateOfBirth
          ? [`name:${normalizedName}|${new Date(dateOfBirth).toDateString()}`]
          : []),
      ];
      const clash = rowKeys.find((key) => seen.has(key));
      if (clash) {
        errors.push(
          `Row ${i + 1}: duplicates an earlier row in this CSV (same ${
            clash.startsWith("phone:") ? "phone" : "name and date of birth"
          })`,
        );
        continue;
      }
      rowKeys.forEach((key) => seen.add(key));

      const duplicate = await findDuplicateMember(prisma, req.gymId, {
        name,
        phone,
        dateOfBirth: dateOfBirth || null,
      });

      if (duplicate) {
        errors.push(`Row ${i + 1}: ${duplicateMessage(duplicate)}`);
        continue;
      }

      const memberData: ImportedMemberData = {
        name,
        ...(email ? { email: email.toLowerCase() } : {}),
        ...(phone ? { phone } : {}),
        ...(row.gender ? { gender: row.gender } : {}),
        ...(row.dateOfBirth
          ? { dateOfBirth: new Date(row.dateOfBirth).toISOString() }
          : {}),
        ...(row.address ? { address: row.address } : {}),
        ...(row.emergencyContact
          ? { emergencyContact: row.emergencyContact }
          : {}),
      };
      createData.push(memberData);
    }

    const createdMembers = [] as string[];
    for (const memberData of createData) {
      // Claimed per row rather than once for the file. An import is not
      // atomic — each member is written on its own — so checking upfront would
      // be checking against a roster that the loop itself is changing, and a
      // file of 200 into a gym with 10 places left would write all 200. The
      // rows that fit are kept: a partial import a gym can see the shape of
      // beats refusing the file outright and leaving them to split it by hand.
      try {
        await prisma.$transaction(async (tx) => {
          await claimMemberPlace(tx, req.gymId);

          const gym = await tx.gym.update({
            where: { id: req.gymId },
            data: { memberSeq: { increment: 1 } },
            select: { memberSeq: true },
          });

          const created = await tx.member.create({
            data: {
              gymId: req.gymId,
              memberNo: formatMemberNo(gym.memberSeq),
              ...memberData,
            },
            select: { id: true },
          });
          createdMembers.push(created.id);
        });
      } catch (err) {
        if (err instanceof PlanLimitError) {
          // Said once, naming what is left rather than repeating per row: a
          // file of 200 rows into a full gym would otherwise return 200
          // identical lines and bury the ones that say something else.
          const { body } = planErrorResponse(err);
          errors.push(
            `${body.error as string} ${createData.length - createdMembers.length} ` +
              `of ${createData.length} rows were not imported.`,
          );
          break;
        }
        throw err;
      }
    }

    res.json({ created: createdMembers.length, errors });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

export const remove = async (
  req: AuthedRequest<IdParam>,
  res: Response,
): Promise<void> => {
  const { id } = req.params;
  try {
    const existing = await prisma.member.findFirst({
      where: { id, gymId: req.gymId },
      select: memberFields,
    });
    if (!existing) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    // Delete photo from S3 if it exists
    if (existing.photoKey) {
      await deletePhoto(existing.photoKey);
    }

    // Every relation is ON DELETE RESTRICT, so children go first. The counts
    // go into the audit entry: how much history went with the member is the
    // part worth knowing afterwards.
    const removed = await prisma.$transaction(async (tx) => {
      const [memberPlans, attendance, payments, memberships] =
        await Promise.all([
          tx.memberPlan.deleteMany({ where: { memberId: id } }),
          tx.attendance.deleteMany({ where: { memberId: id } }),
          tx.payment.deleteMany({ where: { memberId: id } }),
          tx.membership.deleteMany({ where: { memberId: id } }),
        ]);
      await tx.member.delete({ where: { id } });
      return {
        memberPlans: memberPlans.count,
        attendance: attendance.count,
        payments: payments.count,
        memberships: memberships.count,
      };
    });

    await audit(req, {
      action: "member.delete",
      entity: "member",
      entityId: id,
      entityLabel: `${existing.memberNo} · ${existing.name}`,
      before: { ...existing, deletedWith: removed },
    });

    res.json({ message: "Member deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};
