/** @format */

import type { Response } from "express";
import prisma from "../../db.js";
import {
  expiredOverGraceWhere,
  memberStatusWhere,
  recentlyExpiredWhere,
} from "../../services/membership.js";
import type { AuthedRequest } from "../../types.js";
import type { IdParam, MemberQuery, MemberStatusFilter } from "../../schemas.js";
import {
  decorate,
  decorateAllWithPhotos,
  decorateWithPhoto,
  selectMember,
  selectMemberLite,
} from "./shared.js";

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
      // No tab chosen means "everyone still active or recently due (<= 10 days)",
      // which excludes members expired over 10 days and lapsed members.
      //
      // Two things override that: an explicit search, and `all=true` for pickers.
      ...(status
        ? memberStatusWhere(status, now)
        : search || all
          ? {}
          : {
              NOT: [
                memberStatusWhere("lapsed", now),
                expiredOverGraceWhere(now),
              ],
            }),
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

    const [members, total, active, expiring, expired, lapsed, none, recentExpired] =
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
        prisma.member.count({
          where: { ...searchWhere, ...recentlyExpiredWhere(now) },
        }),
      ]);

    res.json({
      data: await decorateAllWithPhotos(members, now),
      total,
      page,
      limit,
      hasMore: page * limit < total,
      // "All" means active, expiring, never bought, plus recently expired (<= 10 days).
      // Members expired over 10 days appear in the Expired tab.
      counts: {
        all: active + expiring + recentExpired + none,
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
