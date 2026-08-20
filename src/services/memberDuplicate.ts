/** @format */

import type { Prisma, PrismaClient } from "@prisma/client";

/** Either the client or a transaction handle — the check runs inside the
 *  create transaction, but the standalone lookup endpoint has no transaction. */
type Db = PrismaClient | Prisma.TransactionClient;

/**
 * A member who already exists, described well enough for the front desk to
 * recognise them without opening another page.
 */
export interface DuplicateMember {
  id: string;
  memberNo: string;
  name: string;
}

/** Which rule matched. The client puts the error under the right field. */
export type DuplicateField = "phone" | "name";

export interface DuplicateHit {
  field: DuplicateField;
  existing: DuplicateMember;
}

/**
 * Strips a phone down to the digits that identify the line, so the same number
 * written three different ways compares equal.
 *
 * `0300-1234567`, `+92 300 1234567` and `(0300) 123 4567` are one number to
 * everybody except a string comparison. Country code and trunk zero both go:
 * what is left is the nine-or-so digits that actually differ between people.
 *
 * Returns null for anything with no digits at all — an empty phone is not a
 * value two members can share.
 */
export const normalizePhone = (phone: string | null | undefined): string | null => {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  // Pakistani numbers arrive as 03001234567, 923001234567 or 3001234567.
  // Reduce all three to the same 3001234567.
  const trimmed = digits.replace(/^92/, "").replace(/^0+/, "");
  return trimmed || digits;
};

/** Names differ only by case and spacing far more often than by person. */
export const normalizeName = (name: string | null | undefined): string | null => {
  if (!name) return null;
  const trimmed = name.trim().replace(/\s+/g, " ").toLowerCase();
  return trimmed || null;
};

/** Only the day matters: two records of one person rarely agree on the time. */
const sameDay = (a: Date | null, b: Date | null | undefined): boolean => {
  if (!a || !b) return false;
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
};

export interface DuplicateCandidate {
  name?: string | null;
  phone?: string | null;
  dateOfBirth?: Date | string | null;
}

const toDate = (value: Date | string | null | undefined): Date | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Finds the active member in this gym that a candidate would duplicate.
 *
 * Two rules, either of which is enough:
 *
 *   - the same phone line, compared on digits rather than formatting;
 *   - the same name *and* the same date of birth.
 *
 * Both rules need real data on each side, so a member with no phone never
 * collides with another member with no phone, and a missing date of birth
 * takes the name rule out of play entirely. Names alone are not a rule: two
 * Muhammad Alis in one gym is ordinary, and blocking the second one would
 * turn a duplicate check into a refusal to serve.
 *
 * Only active members count. Somebody who left is history, not a conflict —
 * and blocking on them would leave the front desk unable to register a walk-in
 * whose namesake quit two years ago.
 *
 * `excludeId` is for edits: a member must not be found to duplicate itself.
 */
export const findDuplicateMember = async (
  db: Db,
  gymId: string,
  candidate: DuplicateCandidate,
  excludeId?: string,
): Promise<DuplicateHit | null> => {
  const phone = normalizePhone(candidate.phone);
  const name = normalizeName(candidate.name);
  const dob = toDate(candidate.dateOfBirth);

  // Nothing comparable was given, so nothing can conflict.
  if (!phone && !(name && dob)) return null;

  // Phone is stored as typed, so it cannot be matched in SQL — the rows are
  // narrowed to this gym's active members and compared in memory. A gym's
  // active roster is small enough that this is cheaper than a schema change
  // and a backfill of every historical number.
  const rows = await db.member.findMany({
    where: {
      gymId,
      status: "active",
      ...(excludeId ? { id: { not: excludeId } } : {}),
      ...(phone && !(name && dob) ? { phone: { not: null } } : {}),
    },
    select: {
      id: true,
      memberNo: true,
      name: true,
      phone: true,
      dateOfBirth: true,
    },
  });

  for (const row of rows) {
    if (phone && normalizePhone(row.phone) === phone) {
      return {
        field: "phone",
        existing: { id: row.id, memberNo: row.memberNo, name: row.name },
      };
    }
  }

  if (name && dob) {
    for (const row of rows) {
      if (normalizeName(row.name) === name && sameDay(row.dateOfBirth, dob)) {
        return {
          field: "name",
          existing: { id: row.id, memberNo: row.memberNo, name: row.name },
        };
      }
    }
  }

  return null;
};

/** The message the front desk sees. Naming the existing member is the point:
 *  "already exists" alone leaves them with nowhere to go next. */
export const duplicateMessage = (hit: DuplicateHit): string =>
  hit.field === "phone"
    ? `This phone number is already registered to ${hit.existing.memberNo} · ${hit.existing.name}`
    : `A member with this name and date of birth already exists: ${hit.existing.memberNo} · ${hit.existing.name}`;
