/** @format */

import type { Response } from "express";
import { Prisma } from "@prisma/client";
import {
  currentMembershipWhere,
  effectiveMemberStatus,
  toView,
  withPlan,
} from "../../services/membership.js";
import { getPhotoUrl } from "../../services/s3.js";
import { duplicateMessage, type DuplicateHit } from "../../services/memberDuplicate.js";
import { claimPlace } from "../../services/subscription.js";

export const memberFields = {
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
export const currentMembership = {
  where: currentMembershipWhere,
  orderBy: { createdAt: "desc" },
  take: 1,
  include: withPlan,
} as const;

export type MemberRow = Prisma.MemberGetPayload<{
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
export const decorate = (
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
export const decorateWithPhoto = async (
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
export const decorateAllWithPhotos = async (
  rows: readonly MemberRow[],
  now: Date = new Date(),
): Promise<Omit<ReturnType<typeof decorate>, "photoKey">[]> =>
  Promise.all(rows.map((r) => decorateWithPhoto(r, now)));

export const selectMember = {
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
export const selectMemberLite = (() => {
  const { photo: _photo, photoKey: _photoKey, ...rest } = memberFields;
  return { ...rest, memberships: currentMembership } as const;
})();

/**
 * Raised inside a transaction when the member being written duplicates one
 * that already exists. Thrown rather than returned so the transaction rolls
 * back — a duplicate detected after the gym's member counter was incremented
 * must not leave that number spent.
 */
export class DuplicateMemberError extends Error {
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
export class UnknownTrainerError extends Error {
  constructor() {
    super("Trainer not found");
    this.name = "UnknownTrainerError";
  }
}

/** The 409 both create and update answer a duplicate with. */
export const respondDuplicate = (res: Response, hit: DuplicateHit): void => {
  res
    .status(409)
    .json({ error: duplicateMessage(hit), field: hit.field, existing: hit.existing });
};

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
export const claimMemberPlace = (tx: Prisma.TransactionClient, gymId: string): Promise<void> =>
  claimPlace(tx, gymId, "members", (t) =>
    t.member.count({ where: { gymId, status: "active" } }),
  );
