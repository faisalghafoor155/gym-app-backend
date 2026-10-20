/** @format */

import type { Response } from "express";
import prisma from "../../db.js";
import { duplicateMessage, findDuplicateMember } from "../../services/memberDuplicate.js";
import type { AuthedRequest } from "../../types.js";
import type { MemberDuplicateQuery } from "../../schemas.js";

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
