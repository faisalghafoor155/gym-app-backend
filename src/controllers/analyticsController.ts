import type { Response } from "express";
import prisma from "../db.js";
import type { AuthedRequest } from "../types.js";
import { memberStatusWhere } from "../services/membership.js";

export const getAttendanceAnalytics = async (
  req: AuthedRequest,
  res: Response,
): Promise<void> => {
  try {
    const gymId = req.gymId;

    // Get last 30 days daily attendance trends (pre-populated map to fill gaps with 0)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

    const dailyCountsMap = new Map<string, number>();
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0];
      dailyCountsMap.set(dateStr, 0);
    }

    const dailyAttendanceRaw = await prisma.attendance.groupBy({
      by: ["checkedInOn"],
      where: {
        gymId,
        checkedInAt: {
          gte: thirtyDaysAgo,
        },
      },
      _count: {
        _all: true,
      },
      orderBy: {
        checkedInOn: "asc",
      },
    });

    dailyAttendanceRaw.forEach((row) => {
      const dateStr = row.checkedInOn.toISOString().split("T")[0];
      if (dailyCountsMap.has(dateStr)) {
        dailyCountsMap.set(dateStr, row._count._all);
      }
    });

    const dailyTrends = Array.from(dailyCountsMap.entries()).map(([date, count]) => ({
      date,
      count,
    }));

    // Get peak hours: Group all check-ins by hour in node server's local timezone
    const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const peakHoursRaw = await prisma.$queryRaw<{ hour: number; count: bigint }[]>`
      SELECT EXTRACT(HOUR FROM "checkedInAt" AT TIME ZONE 'UTC' AT TIME ZONE ${localTimezone})::int as hour, COUNT(*)::bigint as count
      FROM "Attendance"
      WHERE "gymId" = ${gymId}
      GROUP BY hour
      ORDER BY hour ASC
    `;

    const hourlyCounts = new Array(24).fill(0);
    peakHoursRaw.forEach((row) => {
      const hour = row.hour;
      if (hour >= 0 && hour < 24) {
        hourlyCounts[hour] = Number(row.count);
      }
    });

    const peakHours = hourlyCounts.map((count, hour) => ({
      hour: `${hour.toString().padStart(2, "0")}:00`,
      count,
    }));

    // General stats: active members (using same criteria as members page) & today's checkins
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [activeMembersCount, todayCheckinsCount] = await Promise.all([
      prisma.member.count({
        where: {
          gymId,
          ...memberStatusWhere("active"),
        },
      }),
      prisma.attendance.count({
        where: {
          gymId,
          checkedInOn: today,
        },
      }),
    ]);

    const attendanceRate =
      activeMembersCount > 0
        ? Math.round((todayCheckinsCount / activeMembersCount) * 100)
        : 0;

    res.json({
      dailyTrends,
      peakHours,
      stats: {
        activeMembers: activeMembersCount,
        todayCheckins: todayCheckinsCount,
        attendanceRate,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};
