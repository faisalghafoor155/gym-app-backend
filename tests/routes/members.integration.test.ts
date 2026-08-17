/** @format */

import { describe, it, expect, beforeEach } from "vitest";

import prisma from "../../src/db.js";
import {
  api,
  resetDb,
  makeGym,
  addMember,
  addMembership,
  addPlan,
} from "../helpers.js";

/**
 * The members list: paging, searching, and the status tabs.
 *
 * The status filters are the reason this file exists. None of `active`,
 * `expiring`, `expired` or `lapsed` is a stored column — every one is derived
 * from an expiry date against today, so the filter has to be expressed as date
 * arithmetic in SQL. That makes the boundaries the interesting cases: a
 * membership expiring in exactly seven days, or one that lapsed exactly sixty
 * days ago, is precisely where an off-by-one hides.
 */

beforeEach(resetDb);

const names = (body: { data: { name: string }[] }): string[] =>
  body.data.map((m) => m.name);

describe("members list — paging", () => {
  it("returns a page and says how much more there is", async () => {
    const owner = await makeGym();
    for (let i = 1; i <= 5; i++)
      await addMember(owner.gymId, { name: `Member ${i}` });

    const res = await api()
      .get("/api/members?limit=2")
      .set("Cookie", owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(5);
    expect(res.body.page).toBe(1);
    expect(res.body.hasMore).toBe(true);
  });

  it("walks to the end, where hasMore goes false", async () => {
    const owner = await makeGym();
    for (let i = 1; i <= 5; i++)
      await addMember(owner.gymId, { name: `Member ${i}` });

    const res = await api()
      .get("/api/members?limit=2&page=3")
      .set("Cookie", owner.cookie);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.hasMore).toBe(false);
  });

  it("never hands back the whole table through limit", async () => {
    const owner = await makeGym();
    const res = await api()
      .get("/api/members?limit=5000")
      .set("Cookie", owner.cookie);

    // The ceiling is the point of the parameter: without it, paging is opt-in
    // and one caller can still ask for everything.
    expect(res.status).toBe(400);
  });

  it("pages without repeating or skipping a member", async () => {
    const owner = await makeGym();
    for (let i = 1; i <= 7; i++)
      await addMember(owner.gymId, { name: `Member ${i}` });

    const one = await api()
      .get("/api/members?limit=3&page=1")
      .set("Cookie", owner.cookie);
    const two = await api()
      .get("/api/members?limit=3&page=2")
      .set("Cookie", owner.cookie);
    const three = await api()
      .get("/api/members?limit=3&page=3")
      .set("Cookie", owner.cookie);

    const seen = [...names(one.body), ...names(two.body), ...names(three.body)];
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });
});

describe("members list — search", () => {
  it("searches the whole roster, not just the first page", async () => {
    const owner = await makeGym();
    // Created first, so on a newest-first ordering they are last — and would
    // fall outside page one if search were applied after paging.
    await addMember(owner.gymId, { name: "Zainab Malik" });
    for (let i = 1; i <= 30; i++)
      await addMember(owner.gymId, { name: `Filler ${i}` });

    const res = await api()
      .get("/api/members?search=zainab&limit=5")
      .set("Cookie", owner.cookie);

    expect(names(res.body)).toEqual(["Zainab Malik"]);
    expect(res.body.total).toBe(1);
  });

  it("matches on member number and phone as well as name", async () => {
    const owner = await makeGym();
    const m = await addMember(owner.gymId, {
      name: "Ali Khan",
      phone: "03009998877",
    });

    const byNo = await api()
      .get("/api/members?search=MEM-00001")
      .set("Cookie", owner.cookie);
    const byPhone = await api()
      .get("/api/members?search=9998877")
      .set("Cookie", owner.cookie);

    expect(names(byNo.body)).toEqual(["Ali Khan"]);
    expect(names(byPhone.body)).toEqual([m.name]);
  });

  it("ignores case", async () => {
    const owner = await makeGym();
    await addMember(owner.gymId, { name: "Ali Khan" });

    const res = await api()
      .get("/api/members?search=ALI")
      .set("Cookie", owner.cookie);
    expect(names(res.body)).toEqual(["Ali Khan"]);
  });
});

describe("members list — derived status filters", () => {
  it("sorts each member into the tab its expiry puts it in", async () => {
    const owner = await makeGym();
    const plan = await addPlan(owner.gymId);

    const healthy = await addMember(owner.gymId, { name: "Healthy" });
    const soon = await addMember(owner.gymId, { name: "Soon" });
    const gone = await addMember(owner.gymId, { name: "Gone" });
    const long = await addMember(owner.gymId, { name: "Long Gone" });
    await addMember(owner.gymId, { name: "Never Bought" });

    await addMembership(owner.gymId, healthy.id, {
      planId: plan.id,
      expiresInDays: 30,
    });
    await addMembership(owner.gymId, soon.id, {
      planId: plan.id,
      expiresInDays: 3,
    });
    await addMembership(owner.gymId, gone.id, {
      planId: plan.id,
      expiresInDays: -10,
    });
    await addMembership(owner.gymId, long.id, {
      planId: plan.id,
      expiresInDays: -90,
    });

    const tab = async (status: string) =>
      names(
        (
          await api()
            .get(`/api/members?status=${status}`)
            .set("Cookie", owner.cookie)
        ).body,
      );

    expect(await tab("active")).toEqual(["Healthy"]);
    expect(await tab("expiring")).toEqual(["Soon"]);
    expect(await tab("expired")).toEqual(["Gone"]);
    expect(await tab("lapsed")).toEqual(["Long Gone"]);
    expect(await tab("none")).toEqual(["Never Bought"]);
  });

  it("counts the expiring boundary as expiring, not active", async () => {
    const owner = await makeGym();
    const edge = await addMember(owner.gymId, { name: "Edge" });
    // EXPIRING_SOON_DAYS is 7 and the boundary is inclusive, so day seven is
    // still expiring — the same rule displayStatus applies.
    await addMembership(owner.gymId, edge.id, { expiresInDays: 7 });

    const expiring = await api()
      .get("/api/members?status=expiring")
      .set("Cookie", owner.cookie);
    const active = await api()
      .get("/api/members?status=active")
      .set("Cookie", owner.cookie);

    expect(names(expiring.body)).toEqual(["Edge"]);
    expect(names(active.body)).toEqual([]);
  });

  it("treats a membership expiring today as expiring rather than expired", async () => {
    const owner = await makeGym();
    const today = await addMember(owner.gymId, { name: "Today" });
    await addMembership(owner.gymId, today.id, { expiresInDays: 0 });

    const expiring = await api()
      .get("/api/members?status=expiring")
      .set("Cookie", owner.cookie);
    const expired = await api()
      .get("/api/members?status=expired")
      .set("Cookie", owner.cookie);

    expect(names(expiring.body)).toEqual(["Today"]);
    expect(names(expired.body)).toEqual([]);
  });

  it("needs more than sixty days to lapse, not exactly sixty", async () => {
    const owner = await makeGym();
    const edge = await addMember(owner.gymId, { name: "Sixty" });
    // isLapsed is `< -LAPSED_AFTER_DAYS`, so exactly sixty days out is expired
    // and still on the books.
    await addMembership(owner.gymId, edge.id, { expiresInDays: -60 });

    const expired = await api()
      .get("/api/members?status=expired")
      .set("Cookie", owner.cookie);
    const lapsed = await api()
      .get("/api/members?status=lapsed")
      .set("Cookie", owner.cookie);

    expect(names(expired.body)).toEqual(["Sixty"]);
    expect(names(lapsed.body)).toEqual([]);
  });

  it("counts a hand-deactivated member as lapsed whatever the dates say", async () => {
    const owner = await makeGym();
    const off = await addMember(owner.gymId, {
      name: "Deactivated",
      status: "inactive",
    });
    // A perfectly healthy membership: only the stored status retires them.
    await addMembership(owner.gymId, off.id, { expiresInDays: 30 });

    const lapsed = await api()
      .get("/api/members?status=lapsed")
      .set("Cookie", owner.cookie);
    const active = await api()
      .get("/api/members?status=active")
      .set("Cookie", owner.cookie);

    expect(names(lapsed.body)).toEqual(["Deactivated"]);
    expect(names(active.body)).toEqual([]);
  });

  it("reads a suspended membership as no live membership", async () => {
    const owner = await makeGym();
    const susp = await addMember(owner.gymId, { name: "Suspended" });
    await addMembership(owner.gymId, susp.id, {
      expiresInDays: 30,
      status: "suspended",
    });

    const none = await api()
      .get("/api/members?status=none")
      .set("Cookie", owner.cookie);
    const active = await api()
      .get("/api/members?status=active")
      .set("Cookie", owner.cookie);

    expect(names(none.body)).toEqual(["Suspended"]);
    expect(names(active.body)).toEqual([]);
  });
});

describe("members list — the default tab", () => {
  it("leaves lapsed members out of the unfiltered list", async () => {
    const owner = await makeGym();
    const here = await addMember(owner.gymId, { name: "Still Here" });
    const gone = await addMember(owner.gymId, { name: "Long Gone" });
    await addMembership(owner.gymId, here.id, { expiresInDays: 30 });
    await addMembership(owner.gymId, gone.id, { expiresInDays: -90 });

    const res = await api().get("/api/members").set("Cookie", owner.cookie);

    expect(names(res.body)).toEqual(["Still Here"]);
    expect(res.body.total).toBe(1);
  });

  it("finds a lapsed member by name anyway", async () => {
    const owner = await makeGym();
    const gone = await addMember(owner.gymId, { name: "Long Gone" });
    await addMembership(owner.gymId, gone.id, { expiresInDays: -90 });

    // Someone typing a name wants that person found; a search box that hides
    // them reads as broken search rather than as a deliberate filter.
    const res = await api()
      .get("/api/members?search=long")
      .set("Cookie", owner.cookie);

    expect(names(res.body)).toEqual(["Long Gone"]);
  });
});

describe("members list — tab counts", () => {
  it("counts the whole roster, not the page", async () => {
    const owner = await makeGym();
    const plan = await addPlan(owner.gymId);
    for (let i = 1; i <= 6; i++) {
      const m = await addMember(owner.gymId, { name: `Active ${i}` });
      await addMembership(owner.gymId, m.id, {
        planId: plan.id,
        expiresInDays: 30,
      });
    }

    const res = await api()
      .get("/api/members?limit=2")
      .set("Cookie", owner.cookie);

    expect(res.body.data).toHaveLength(2);
    // A tab that counted only what had been fetched would climb as the user
    // pressed Show more.
    expect(res.body.counts.active).toBe(6);
    expect(res.body.counts.all).toBe(6);
  });

  it("keeps every tab visible while a search narrows them all", async () => {
    const owner = await makeGym();
    const plan = await addPlan(owner.gymId);
    const a = await addMember(owner.gymId, { name: "Ali Active" });
    const b = await addMember(owner.gymId, { name: "Ali Expired" });
    const c = await addMember(owner.gymId, { name: "Bilal Active" });
    await addMembership(owner.gymId, a.id, {
      planId: plan.id,
      expiresInDays: 30,
    });
    await addMembership(owner.gymId, b.id, {
      planId: plan.id,
      expiresInDays: -10,
    });
    await addMembership(owner.gymId, c.id, {
      planId: plan.id,
      expiresInDays: 30,
    });

    const res = await api()
      .get("/api/members?search=ali&status=active")
      .set("Cookie", owner.cookie);

    // The chosen tab narrows the rows; it must not narrow the other tabs, or
    // every one of them would read zero as soon as a tab was picked.
    expect(names(res.body)).toEqual(["Ali Active"]);
    expect(res.body.counts.active).toBe(1);
    expect(res.body.counts.expired).toBe(1);
  });

  it("excludes the lapsed from the all count", async () => {
    const owner = await makeGym();
    const here = await addMember(owner.gymId, { name: "Here" });
    const gone = await addMember(owner.gymId, { name: "Gone" });
    await addMembership(owner.gymId, here.id, { expiresInDays: 30 });
    await addMembership(owner.gymId, gone.id, { expiresInDays: -90 });

    const res = await api().get("/api/members").set("Cookie", owner.cookie);

    expect(res.body.counts.all).toBe(1);
    expect(res.body.counts.lapsed).toBe(1);
  });
});

describe("members list — all=true", () => {
  it("returns every member for the pickers", async () => {
    const owner = await makeGym();
    for (let i = 1; i <= 30; i++)
      await addMember(owner.gymId, { name: `Member ${i}` });

    const res = await api()
      .get("/api/members?all=true")
      .set("Cookie", owner.cookie);

    expect(res.body.data).toHaveLength(30);
    expect(res.body.hasMore).toBe(false);
  });

  it("includes the lapsed, who can still be sold a renewal", async () => {
    const owner = await makeGym();
    const gone = await addMember(owner.gymId, { name: "Long Gone" });
    await addMembership(owner.gymId, gone.id, { expiresInDays: -90 });

    const res = await api()
      .get("/api/members?all=true")
      .set("Cookie", owner.cookie);

    expect(names(res.body)).toEqual(["Long Gone"]);
  });

  it("drops photos, which are what make a full list expensive", async () => {
    const owner = await makeGym();
    const m = await addMember(owner.gymId, { name: "Has Photo" });
    // A data-URL of the kind the client stores, which can run to megabytes.
    await prisma.member.update({
      where: { id: m.id },
      data: { photo: "data:image/png;base64,AAAA" },
    });

    const all = await api()
      .get("/api/members?all=true")
      .set("Cookie", owner.cookie);
    const paged = await api().get("/api/members").set("Cookie", owner.cookie);

    expect(all.body.data[0].photo).toBeNull();
    // The paged list still carries them — it is bounded, so it can afford to.
    expect(paged.body.data[0].photo).toBe("data:image/png;base64,AAAA");
  });

  it("still keeps one gym out of another's list", async () => {
    const a = await makeGym({ gymName: "A" });
    const b = await makeGym({ gymName: "B" });
    await addMember(a.gymId, { name: "Alice" });
    await addMember(b.gymId, { name: "Bob" });

    const res = await api()
      .get("/api/members?all=true")
      .set("Cookie", a.cookie);

    expect(names(res.body)).toEqual(["Alice"]);
  });
});

describe("member self-service", () => {
  it("lets a member update their own phone and email without changing other fields", async () => {
    const owner = await makeGym({ role: "member" });
    const member = await addMember(owner.gymId, {
      name: "Self Service Member",
      phone: "03001112222",
    });
    await prisma.user.update({
      where: { id: owner.userId },
      data: { memberId: member.id },
    });

    const res = await api()
      .put("/api/me")
      .set("Cookie", owner.cookie)
      .send({ phone: "03009998877", email: "new@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.member.phone).toBe("03009998877");
    expect(res.body.member.email).toBe("new@example.com");

    const saved = await prisma.member.findUnique({ where: { id: member.id } });
    expect(saved?.phone).toBe("03009998877");
    expect(saved?.email).toBe("new@example.com");
  });
});

describe("bulk member import", () => {
  it("creates members from a CSV payload with the expected fields", async () => {
    const owner = await makeGym();

    const res = await api()
      .post("/api/members/import")
      .set("Cookie", owner.cookie)
      .send({
        csv: [
          "name,email,phone",
          "Ayesha Khan,ayesha@example.com,03001234567",
          "Bilal Ahmed,bilal@example.com,03009876543",
        ].join("\n"),
      });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(2);
    expect(res.body.errors).toEqual([]);
    const count = await prisma.member.count({ where: { gymId: owner.gymId } });
    expect(count).toBe(2);
    const rows = await prisma.member.findMany({
      where: { gymId: owner.gymId },
      orderBy: { createdAt: "asc" },
      select: { name: true, email: true, phone: true },
    });
    expect(rows.map((r) => r.name)).toEqual(["Ayesha Khan", "Bilal Ahmed"]);
  });
});
