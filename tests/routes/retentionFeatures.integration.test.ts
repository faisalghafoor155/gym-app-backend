/** @format */

import { describe, it, expect, beforeEach } from "vitest";

import prisma from "../../src/db.js";
import { addDays, startOfDay } from "../../src/services/membership.js";
import { api, resetDb, makeGym, addMember, addMembership, addPlan, addUser } from "../helpers.js";

/**
 * The features that keep members coming back and money coming in: freezing a
 * membership, working enquiries, part-payments, weigh-ins and greetings.
 */

beforeEach(resetDb);

const ymd = (d: Date): string => {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};

describe("membership freeze", () => {
  it("moves the expiry by the days frozen and reports the window", async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const ms = await addMembership(owner.gymId, member.id, { expiresInDays: 20 });
    const before = await prisma.membership.findUniqueOrThrow({ where: { id: ms.id } });

    const res = await api()
      .post(`/api/members/${member.id}/memberships/${ms.id}/freeze`)
      .set("Cookie", owner.cookie)
      .send({ days: 10, reason: "Travel" });

    expect(res.status).toBe(200);
    expect(res.body.freeze).not.toBeNull();
    const after = await prisma.membership.findUniqueOrThrow({ where: { id: ms.id } });
    expect(after.expiryDate.getTime()).toBe(addDays(before.expiryDate, 10).getTime());
    expect(await prisma.membershipFreeze.count({ where: { membershipId: ms.id } })).toBe(1);
  });

  it("refuses a second freeze while one is running", async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const ms = await addMembership(owner.gymId, member.id, { expiresInDays: 20 });
    const url = `/api/members/${member.id}/memberships/${ms.id}/freeze`;

    await api().post(url).set("Cookie", owner.cookie).send({ days: 5 });
    const second = await api().post(url).set("Cookie", owner.cookie).send({ days: 5 });

    expect(second.status).toBe(400);
  });

  it("refuses an expired membership and an over-long freeze", async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const expired = await addMembership(owner.gymId, member.id, { expiresInDays: -3 });
    const url = `/api/members/${member.id}/memberships/${expired.id}/freeze`;

    expect((await api().post(url).set("Cookie", owner.cookie).send({ days: 5 })).status).toBe(400);
    expect((await api().post(url).set("Cookie", owner.cookie).send({ days: 500 })).status).toBe(400);
  });

  it("gives back every day when a booked freeze is called off before it starts", async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const ms = await addMembership(owner.gymId, member.id, { expiresInDays: 20 });
    const original = await prisma.membership.findUniqueOrThrow({ where: { id: ms.id } });
    const base = `/api/members/${member.id}/memberships/${ms.id}`;

    await api()
      .post(`${base}/freeze`)
      .set("Cookie", owner.cookie)
      .send({ days: 7, startDate: ymd(addDays(new Date(), 3)) });
    const res = await api().post(`${base}/unfreeze`).set("Cookie", owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body.freeze).toBeNull();
    const after = await prisma.membership.findUniqueOrThrow({ where: { id: ms.id } });
    expect(after.expiryDate.getTime()).toBe(original.expiryDate.getTime());
    const row = await prisma.membershipFreeze.findFirstOrThrow({ where: { membershipId: ms.id } });
    expect(row.days).toBe(0);
  });
});

describe("leads", () => {
  it("lists due follow-ups and the open set, and converts a lead once", async () => {
    const owner = await makeGym();
    const create = (body: Record<string, unknown>) =>
      api().post("/api/leads").set("Cookie", owner.cookie).send(body);

    const due = await create({ name: "Ali", phone: "03001112222", followUpOn: ymd(addDays(new Date(), -1)) });
    await create({ name: "Sara", followUpOn: ymd(addDays(new Date(), 5)) });
    const lost = await create({ name: "Bilal", status: "lost" });
    expect(due.status).toBe(201);

    const dueList = await api().get("/api/leads?due=true").set("Cookie", owner.cookie);
    expect(dueList.body.data.map((l: { name: string }) => l.name)).toEqual(["Ali"]);
    expect(dueList.body.counts.due).toBe(1);

    const open = await api().get("/api/leads?status=open").set("Cookie", owner.cookie);
    expect(open.body.data.map((l: { name: string }) => l.name).sort()).toEqual(["Ali", "Sara"]);
    expect(open.body.data.some((l: { id: string }) => l.id === lost.body.id)).toBe(false);

    const member = await addMember(owner.gymId, { name: "Ali" });
    const converted = await api()
      .post(`/api/leads/${due.body.id}/convert`)
      .set("Cookie", owner.cookie)
      .send({ memberId: member.id });
    expect(converted.status).toBe(200);
    expect(converted.body.status).toBe("converted");
    expect(converted.body.convertedMember.id).toBe(member.id);

    // The same member cannot be the outcome of a second enquiry.
    const again = await api()
      .post(`/api/leads/${lost.body.id}/convert`)
      .set("Cookie", owner.cookie)
      .send({ memberId: member.id });
    expect(again.status).toBe(409);

    // And a converted lead's status is fixed.
    const reopen = await api()
      .put(`/api/leads/${due.body.id}`)
      .set("Cookie", owner.cookie)
      .send({ status: "new" });
    expect(reopen.status).toBe(400);
  });

  it("keeps another gym's leads out of reach", async () => {
    const a = await makeGym();
    const b = await makeGym();
    const lead = await api().post("/api/leads").set("Cookie", a.cookie).send({ name: "Ali" });

    const res = await api().put(`/api/leads/${lead.body.id}`).set("Cookie", b.cookie).send({ name: "x" });
    expect(res.status).toBe(404);
    expect((await api().get("/api/leads").set("Cookie", b.cookie)).body.total).toBe(0);
  });
});

describe("part-payments and the dues list", () => {
  const renewWith = async (body: Record<string, unknown>) => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const plan = await addPlan(owner.gymId, { price: 5000 });
    const ms = await addMembership(owner.gymId, member.id, { planId: plan.id, expiresInDays: 2 });
    const res = await api()
      .post(`/api/members/${member.id}/memberships/${ms.id}/renew`)
      .set("Cookie", owner.cookie)
      .send({ method: "cash", ...body });
    return { owner, member, res };
  };

  it("lists what a part-paid renewal still owes, and clears it when collected", async () => {
    const { owner, member, res } = await renewWith({ amount: 2000 });
    expect(res.status).toBe(201);

    const balances = await api().get("/api/payments/balances").set("Cookie", owner.cookie);
    expect(balances.status).toBe(200);
    expect(balances.body.memberships).toHaveLength(1);
    const row = balances.body.memberships[0];
    expect(row).toMatchObject({ expected: 5000, paid: 2000, outstanding: 3000 });
    expect(balances.body.totalOutstanding).toBe(3000);

    await api()
      .post("/api/payments")
      .set("Cookie", owner.cookie)
      .send({ memberId: member.id, membershipId: row.membershipId, amount: 3000, method: "cash", type: "membership" });

    const after = await api().get("/api/payments/balances").set("Cookie", owner.cookie);
    expect(after.body.memberships).toHaveLength(0);
    expect(after.body.totalOutstanding).toBe(0);
  });

  it("treats an agreed lower price as a discount rather than a debt", async () => {
    const { owner, res } = await renewWith({ amount: 4000, price: 4000 });
    expect(res.status).toBe(201);

    const balances = await api().get("/api/payments/balances").set("Cookie", owner.cookie);
    expect(balances.body.memberships).toHaveLength(0);
  });

  it("refuses paying more than the agreed price", async () => {
    const { res } = await renewWith({ amount: 4500, price: 4000 });
    expect(res.status).toBe(400);
  });
});

describe("member measurements", () => {
  it("lets staff log and read a member's weigh-ins, numbers as numbers", async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const url = `/api/members/${member.id}/measurements`;

    const created = await api().post(url).set("Cookie", owner.cookie).send({ weightKg: "82.5", waistCm: 90 });
    expect(created.status).toBe(201);
    expect(created.body.weightKg).toBe(82.5);

    const list = await api().get(url).set("Cookie", owner.cookie);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).not.toHaveProperty("photoKey");
  });

  it("refuses an entry that records nothing", async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const res = await api()
      .post(`/api/members/${member.id}/measurements`)
      .set("Cookie", owner.cookie)
      .send({ notes: "nothing measured" });
    expect(res.status).toBe(400);
  });

  it("lets a member remove what they logged, but not what the gym recorded", async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const self = await addUser(owner.gymId, { role: "member", memberId: member.id });

    const mine = await api().post("/api/me/measurements").set("Cookie", self.cookie).send({ weightKg: 80 });
    const gyms = await api()
      .post(`/api/members/${member.id}/measurements`)
      .set("Cookie", owner.cookie)
      .send({ weightKg: 81 });

    const list = await api().get("/api/me/measurements").set("Cookie", self.cookie);
    expect(list.body.data).toHaveLength(2);

    expect((await api().delete(`/api/me/measurements/${gyms.body.id}`).set("Cookie", self.cookie)).status).toBe(403);
    expect((await api().delete(`/api/me/measurements/${mine.body.id}`).set("Cookie", self.cookie)).status).toBe(204);
  });
});

describe("GET /dashboard/celebrations", () => {
  it("lists today's birthdays for members still on the roster", async () => {
    const owner = await makeGym();
    const today = startOfDay(new Date());
    // A calendar date, stored as midnight UTC, the way the form saves one.
    const dob = new Date(Date.UTC(1995, today.getMonth(), today.getDate()));

    const active = await addMember(owner.gymId, { name: "Birthday Active", dateOfBirth: dob });
    await addMembership(owner.gymId, active.id, { expiresInDays: 10 });
    // Same birthday, but nobody has sold them anything — not on the roster.
    await addMember(owner.gymId, { name: "Birthday Nobody", dateOfBirth: dob });

    const res = await api().get("/api/dashboard/celebrations").set("Cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.birthdays.map((b: { name: string }) => b.name)).toEqual(["Birthday Active"]);
    expect(res.body.birthdays[0].turning).toBe(today.getFullYear() - 1995);
    expect(res.body.birthdays[0]).not.toHaveProperty("whatsappOptOut");
  });
});
