/** @format */

import { describe, it, expect, beforeEach } from "vitest";

import prisma from "../../src/db.js";
import { api, resetDb, makeGym, addUser, addMember } from "../helpers.js";

/**
 * The audit trail endpoint.
 *
 * Owner-only, and that is the part worth defending: the log names which member
 * of staff did what, so serving it to staff would hand them the record kept
 * about them. The rest is filtering and paging over a table that only ever
 * grows.
 */

beforeEach(resetDb);

const addLog = (
  gymId: string,
  actorId: string,
  over: Partial<{
    action: string;
    entity: string;
    entityLabel: string;
    createdAt: Date;
    actorName: string;
  }> = {},
) =>
  prisma.auditLog.create({
    data: {
      gymId,
      actorId,
      actorName: over.actorName ?? "Owner User",
      actorRole: "owner",
      action: over.action ?? "member.create",
      entity: over.entity ?? "member",
      entityId: "entity-1",
      entityLabel: over.entityLabel ?? "MEM-00001 · Ali Khan",
      ...(over.createdAt && { createdAt: over.createdAt }),
    },
    select: { id: true },
  });

describe("GET /api/audit-logs — access", () => {
  it("serves the owner", async () => {
    const owner = await makeGym();
    await addLog(owner.gymId, owner.userId);

    const res = await api().get("/api/audit-logs").set("Cookie", owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("refuses staff, whatever their permissions", async () => {
    const owner = await makeGym();
    const staff = await addUser(owner.gymId, {
      role: "staff",
      staffPermission: "manager",
    });
    await addLog(owner.gymId, owner.userId);

    const res = await api().get("/api/audit-logs").set("Cookie", staff.cookie);

    // The log is the record kept *about* staff — a manager reading it would be
    // reading their own trail.
    expect(res.status).toBe(403);
  });

  it("refuses a member account", async () => {
    const owner = await makeGym();
    const memberRecord = await addMember(owner.gymId);
    const member = await addUser(owner.gymId, {
      role: "member",
      memberId: memberRecord.id,
    });

    const res = await api().get("/api/audit-logs").set("Cookie", member.cookie);

    expect(res.status).toBe(403);
  });

  it("refuses a caller with no session", async () => {
    const res = await api().get("/api/audit-logs");
    expect(res.status).toBe(401);
  });

  it("never shows one gym another gym's trail", async () => {
    const a = await makeGym();
    const b = await makeGym({ gymName: "Other Gym" });
    await addLog(a.gymId, a.userId);

    const res = await api().get("/api/audit-logs").set("Cookie", b.cookie);

    expect(res.body.data).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });
});

describe("GET /api/audit-logs — filtering", () => {
  it("narrows to one kind of thing", async () => {
    const owner = await makeGym();
    await addLog(owner.gymId, owner.userId, { entity: "member" });
    await addLog(owner.gymId, owner.userId, {
      entity: "payment",
      action: "payment.create",
    });

    const res = await api()
      .get("/api/audit-logs?entity=payment")
      .set("Cookie", owner.cookie);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].entity).toBe("payment");
  });

  it("narrows to one actor", async () => {
    const owner = await makeGym();
    const other = await addUser(owner.gymId, { role: "staff" });
    await addLog(owner.gymId, owner.userId);
    await addLog(owner.gymId, other.userId, { actorName: "Front Desk" });

    const res = await api()
      .get(`/api/audit-logs?actorId=${other.userId}`)
      .set("Cookie", owner.cookie);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].actorName).toBe("Front Desk");
  });

  it("includes everything that happened on the closing day", async () => {
    const owner = await makeGym();
    await addLog(owner.gymId, owner.userId, {
      // Late in the day: a `to` filter compared against midnight would miss it.
      createdAt: new Date("2026-08-10T23:30:00.000Z"),
    });

    const res = await api()
      .get("/api/audit-logs?from=2026-08-01&to=2026-08-10")
      .set("Cookie", owner.cookie);

    expect(res.body.data).toHaveLength(1);
  });

  it("leaves out what falls outside the range", async () => {
    const owner = await makeGym();
    await addLog(owner.gymId, owner.userId, {
      createdAt: new Date("2026-07-15T12:00:00.000Z"),
    });

    const res = await api()
      .get("/api/audit-logs?from=2026-08-01&to=2026-08-31")
      .set("Cookie", owner.cookie);

    expect(res.body.data).toHaveLength(0);
  });

  it("rejects a range that ends before it starts", async () => {
    const owner = await makeGym();

    const res = await api()
      .get("/api/audit-logs?from=2026-08-31&to=2026-08-01")
      .set("Cookie", owner.cookie);

    expect(res.status).toBe(400);
  });
});

describe("GET /api/audit-logs — paging", () => {
  it("returns newest first", async () => {
    const owner = await makeGym();
    await addLog(owner.gymId, owner.userId, {
      entityLabel: "older",
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
    });
    await addLog(owner.gymId, owner.userId, {
      entityLabel: "newer",
      createdAt: new Date("2026-08-09T10:00:00.000Z"),
    });

    const res = await api().get("/api/audit-logs").set("Cookie", owner.cookie);

    expect(res.body.data.map((l: { entityLabel: string }) => l.entityLabel))
      .toEqual(["newer", "older"]);
  });

  it("says how much more there is", async () => {
    const owner = await makeGym();
    for (let i = 0; i < 5; i++) await addLog(owner.gymId, owner.userId);

    const res = await api()
      .get("/api/audit-logs?limit=2")
      .set("Cookie", owner.cookie);

    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(5);
    expect(res.body.hasMore).toBe(true);
  });

  it("never hands back the whole table through limit", async () => {
    const owner = await makeGym();

    // The ceiling is the point of the parameter: this is the one table that
    // only ever grows.
    const res = await api()
      .get("/api/audit-logs?limit=5000")
      .set("Cookie", owner.cookie);

    expect(res.status).toBe(400);
  });
});
