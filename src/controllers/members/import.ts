/** @format */

import type { Response } from "express";
import prisma from "../../db.js";
import { formatMemberNo } from "../../services/membership.js";
import {
  duplicateMessage,
  findDuplicateMember,
  normalizeName,
  normalizePhone,
} from "../../services/memberDuplicate.js";
import { planErrorResponse, PlanLimitError } from "../../services/subscription.js";
import type { AuthedRequest } from "../../types.js";
import { claimMemberPlace } from "./shared.js";

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
