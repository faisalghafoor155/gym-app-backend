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
  uploadPhoto,
  deletePhoto,
  base64ToBuffer,
  extractFilename,
} from "../services/s3.js";
import { buildPtFeeCharge, trainerFeeSelect } from "../services/trainerFee.js";
import type { AuthedRequest } from "../types.js";
import type {
  CreateMemberBody,
  UpdateMemberBody,
  IdParam,
  MemberQuery,
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
  photoUrl: true,
  gender: true,
  dateOfBirth: true,
  address: true,
  emergencyContact: true,
  status: true,
  createdAt: true,
  trainerId: true,
  trainer: { select: { id: true, name: true } },
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
 */
const selectMemberLite = (() => {
  const { photo: _photo, ...rest } = memberFields;
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
  const { search, status, page, limit, all } = req.query;
  try {
    // One clock for the whole request, so the rows, the filter boundaries and
    // the count can never disagree about what "today" was.
    const now = new Date();

    const where = {
      gymId: req.gymId,
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
        data: members.map((m) => decorate({ ...m, photo: null }, now)),
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
    const searchWhere = { gymId: req.gymId, ...(where.OR && { OR: where.OR }) };
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
      data: members.map((m) => decorate(m, now)),
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
    res.json(decorate(member));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
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
export const create = async (
  req: AuthedRequest<Record<string, string>, unknown, CreateMemberBody>,
  res: Response,
): Promise<void> => {
  // `ptFee`/`ptFeePaid` are pulled out with the rest: they price and settle the
  // trainer assignment and are not columns on the member, so they must not
  // reach the create below.
  const { planId, startDate, photo, ptFee, ptFeePaid, ...fields } = req.body;
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

    // Handle photo upload to S3 before creating member
    let photoData: { photo?: string; photoKey?: string; photoUrl?: string } =
      {};
    if (photo && isS3Configured()) {
      try {
        // Generate a temporary ID for the filename
        const tempId = `new-${Date.now()}`;
        const buffer = base64ToBuffer(photo);
        const filename = extractFilename(photo, `member-${tempId}`);
        const { key, url } = await uploadPhoto(buffer, filename, tempId);
        photoData = { photoKey: key, photoUrl: url };
      } catch (uploadError) {
        console.error("Photo upload failed:", uploadError);
        res.status(400).json({ error: "Failed to upload photo" });
        return;
      }
    } else if (photo && !isS3Configured()) {
      // Fallback to base64 storage if S3 not configured
      photoData = { photo };
    }

    const member = await prisma.$transaction(async (tx) => {
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

      if (planId) {
        const plan = await tx.membershipPlan.findUniqueOrThrow({
          where: { id: planId },
        });
        const start = startDate ?? new Date();
        const expiry = addDays(start, plan.durationDays);

        await tx.membership.create({
          data: {
            gymId: req.gymId,
            memberId: created.id,
            planId: plan.id,
            startDate: start,
            expiryDate: expiry,
            originalExpiryDate: expiry,
            pricePaid: plan.price,
          },
        });
      }

      if (fields.trainerId) {
        const trainer = await tx.trainer.findFirst({
          // Scoped by gym: a trainer id from elsewhere must not resolve here
          // and put another gym's name on this member's bill.
          where: { id: fields.trainerId, gymId: req.gymId },
          select: trainerFeeSelect,
        });
        if (trainer) {
          const charge = buildPtFeeCharge(
            req.gymId,
            created.id,
            trainer,
            { defaultPtFee: gym.defaultPtFee },
            { override: ptFee, paid: ptFeePaid, recordedById: req.userId },
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
    const view = decorate(full);

    await audit(req, {
      action: "member.create",
      entity: "member",
      entityId: member.id,
      entityLabel: `${member.memberNo} · ${member.name}`,
      after: { ...member, membership: view.currentMembership },
    });

    res.status(201).json(view);
  } catch (err) {
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
      photoUrl?: string | null;
    } = {};

    // Handle photo upload to S3 if provided and S3 is configured
    if (photo !== undefined) {
      if (photo === null) {
        // Delete existing photo
        if (existing.photoKey) {
          await deletePhoto(existing.photoKey);
        }
        photoData = { photo: null, photoKey: null, photoUrl: null };
      } else if (photo && isS3Configured()) {
        // Upload new photo to S3
        try {
          const buffer = base64ToBuffer(photo);
          const filename = extractFilename(photo, `member-${id}`);
          const { key, url } = await uploadPhoto(buffer, filename, id);

          // Delete old photo if exists
          if (existing.photoKey) {
            await deletePhoto(existing.photoKey);
          }

          photoData = { photo: null, photoKey: key, photoUrl: url };
        } catch (uploadError) {
          console.error("Photo upload failed:", uploadError);
          res.status(400).json({ error: "Failed to upload photo" });
          return;
        }
      } else if (photo && !isS3Configured()) {
        // Fallback to base64 storage if S3 not configured
        photoData = { photo };
      }
    }

    await prisma.$transaction(async (tx) => {
      // Charged when the member moves onto a trainer they were not already
      // with — including a switch between trainers, since that is a new
      // engagement with a fee of its own.
      if (trainerId && trainerId !== existing.trainerId) {
        const [trainer, gym] = await Promise.all([
          tx.trainer.findFirst({
            where: { id: trainerId, gymId: req.gymId },
            select: trainerFeeSelect,
          }),
          tx.gym.findUniqueOrThrow({
            where: { id: req.gymId },
            select: { defaultPtFee: true },
          }),
        ]);
        if (trainer) {
          const charge = buildPtFeeCharge(req.gymId, id, trainer, gym, {
            override: ptFee,
            paid: ptFeePaid,
            recordedById: req.userId,
          });
          if (charge) await tx.payment.create({ data: charge });
        }
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

    res.json(decorate(full));
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
      const dedupeKey = `${(email || phone || "").toLowerCase()}`;
      if (dedupeKey && seen.has(dedupeKey)) {
        errors.push(`Row ${i + 1}: duplicate contact value in this CSV`);
        continue;
      }
      if (dedupeKey) seen.add(dedupeKey);

      const existing = await prisma.member.findFirst({
        where: {
          gymId: req.gymId,
          OR: [
            ...(email
              ? [
                  {
                    email: {
                      equals: email.toLowerCase(),
                      mode: "insensitive" as const,
                    },
                  },
                ]
              : []),
            ...(phone
              ? [{ phone: { equals: phone, mode: "insensitive" as const } }]
              : []),
          ],
        },
        select: { id: true },
      });

      if (existing) {
        errors.push(
          `Row ${i + 1}: member with this email or phone already exists`,
        );
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
      const gym = await prisma.gym.update({
        where: { id: req.gymId },
        data: { memberSeq: { increment: 1 } },
        select: { memberSeq: true },
      });

      const created = await prisma.member.create({
        data: {
          gymId: req.gymId,
          memberNo: formatMemberNo(gym.memberSeq),
          ...memberData,
        },
        select: { id: true },
      });
      createdMembers.push(created.id);
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
