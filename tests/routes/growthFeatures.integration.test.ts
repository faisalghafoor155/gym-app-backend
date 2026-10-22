/** @format */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import prisma from "../../src/db.js";
import { addDays } from "../../src/services/membership.js";
import { api, resetDb, makeGym, addMember, addMembership, addPlan } from "../helpers.js";

/**
 * Referrals, promo codes, inactivity, lockers, supplement stock/profit and the
 * SMS fallback.
 */

beforeEach(resetDb);

const register = (cookie: string, body: Record<string, unknown>) =>
  api().post("/api/members").set("Cookie", cookie).send({ name: "New Member", ...body });

describe("promo codes", () => {
  it("discounts a registration on the server and spends one use", async () => {
    const owner = await makeGym();
    const plan = await addPlan(owner.gymId, { price: 4000 });
    const promo = await api()
      .post("/api/promo-codes")
      .set("Cookie", owner.cookie)
      .send({ code: "eid25", kind: "percent", value: 25, maxUses: 1 });
    expect(promo.status).toBe(201);
    expect(promo.body.code).toBe("EID25");

    const check = await api()
      .get(`/api/promo-codes/check?code=Eid25&planId=${plan.id}`)
      .set("Cookie", owner.cookie);
    expect(check.body).toMatchObject({ price: 4000, discount: 1000, finalPrice: 3000 });

    const first = await register(owner.cookie, { planId: plan.id, promoCode: "eid25", phone: "03001110001" });
    expect(first.status).toBe(201);
    expect(first.body.currentMembership.pricePaid).toBe(3000);

    // maxUses 1: the second registration is refused, and nothing is created.
    const second = await register(owner.cookie, { name: "Second", planId: plan.id, promoCode: "EID25", phone: "03001110002" });
    expect(second.status).toBe(400);
    expect(await prisma.member.count({ where: { gymId: owner.gymId } })).toBe(1);

    const row = await prisma.promoCode.findFirstOrThrow({ where: { gymId: owner.gymId } });
    expect(row.usedCount).toBe(1);
    expect(await prisma.promoRedemption.count()).toBe(1);
  });

  it("applies a fixed code on renewal and refuses it together with a hand-typed price", async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const plan = await addPlan(owner.gymId, { price: 5000 });
    const ms = await addMembership(owner.gymId, member.id, { planId: plan.id, expiresInDays: 2 });
    await api().post("/api/promo-codes").set("Cookie", owner.cookie)
      .send({ code: "FAMILY", kind: "fixed", value: 1000 });
    const url = `/api/members/${member.id}/memberships/${ms.id}/renew`;

    const both = await api().post(url).set("Cookie", owner.cookie)
      .send({ amount: 3000, method: "cash", promoCode: "FAMILY", price: 3000 });
    expect(both.status).toBe(400);

    const ok = await api().post(url).set("Cookie", owner.cookie)
      .send({ amount: 4000, method: "cash", promoCode: "family" });
    expect(ok.status).toBe(201);
    expect(ok.body.pricePaid).toBe(4000);
  });

  it("refuses an expired code and keeps a used code by switching it off", async () => {
    const owner = await makeGym();
    const plan = await addPlan(owner.gymId);
    const old = await api().post("/api/promo-codes").set("Cookie", owner.cookie)
      .send({ code: "OLD", kind: "fixed", value: 100, validUntil: addDays(new Date(), -2).toISOString() });
    const check = await api().get(`/api/promo-codes/check?code=OLD&planId=${plan.id}`).set("Cookie", owner.cookie);
    expect(check.status).toBe(400);
    expect(check.body.error).toMatch(/expired/);

    const used = await api().post("/api/promo-codes").set("Cookie", owner.cookie)
      .send({ code: "USED", kind: "fixed", value: 100 });
    await register(owner.cookie, { planId: plan.id, promoCode: "USED" });
    const del = await api().delete(`/api/promo-codes/${used.body.id}`).set("Cookie", owner.cookie);
    expect(del.body).toEqual({ deactivated: true });
    expect((await prisma.promoCode.findUniqueOrThrow({ where: { id: used.body.id } })).isActive).toBe(false);

    expect((await api().delete(`/api/promo-codes/${old.body.id}`).set("Cookie", owner.cookie)).status).toBe(204);
  });
});

describe("referrals", () => {
  it("records a referral at registration and grants free days onto the referrer", async () => {
    const owner = await makeGym();
    await prisma.gym.update({ where: { id: owner.gymId }, data: { referralRewardDays: 7 } });
    const referrer = await addMember(owner.gymId, { name: "Ali" });
    const ms = await addMembership(owner.gymId, referrer.id, { expiresInDays: 20 });
    const before = await prisma.membership.findUniqueOrThrow({ where: { id: ms.id } });

    const friend = await register(owner.cookie, { name: "Friend", referredById: referrer.id });
    expect(friend.status).toBe(201);

    const list = await api().get("/api/referrals").set("Cookie", owner.cookie);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ status: "pending", rewardDays: 7 });
    expect(list.body.topReferrers[0]).toMatchObject({ referrals: 1, member: { name: "Ali" } });

    const grant = await api().post(`/api/referrals/${list.body.data[0].id}/grant`).set("Cookie", owner.cookie).send({});
    expect(grant.status).toBe(200);
    const after = await prisma.membership.findUniqueOrThrow({ where: { id: ms.id } });
    expect(after.expiryDate.getTime()).toBe(addDays(before.expiryDate, 7).getTime());

    const again = await api().post(`/api/referrals/${list.body.data[0].id}/grant`).set("Cookie", owner.cookie).send({});
    expect(again.status).toBe(400);
  });

  it("refuses a referrer from another gym", async () => {
    const owner = await makeGym();
    const other = await makeGym();
    const stranger = await addMember(other.gymId);
    const res = await register(owner.cookie, { referredById: stranger.id });
    expect(res.status).toBe(404);
    expect(await prisma.member.count({ where: { gymId: owner.gymId } })).toBe(0);
  });

  it("asks for a note when the referrer has nothing running to add days to", async () => {
    const owner = await makeGym();
    await prisma.gym.update({ where: { id: owner.gymId }, data: { referralRewardDays: 7 } });
    const referrer = await addMember(owner.gymId);
    await register(owner.cookie, { referredById: referrer.id });
    const [reward] = (await api().get("/api/referrals").set("Cookie", owner.cookie)).body.data;

    const bare = await api().post(`/api/referrals/${reward.id}/grant`).set("Cookie", owner.cookie).send({});
    expect(bare.status).toBe(400);
    const noted = await api().post(`/api/referrals/${reward.id}/grant`).set("Cookie", owner.cookie)
      .send({ note: "Gave a shaker bottle" });
    expect(noted.status).toBe(200);
    expect(noted.body.note).toBe("Gave a shaker bottle");
  });
});

describe("GET /attendance/inactive", () => {
  it("lists paying members who have not been in for the threshold", async () => {
    const owner = await makeGym();
    const away = await addMember(owner.gymId, { name: "Away" });
    await addMembership(owner.gymId, away.id, { expiresInDays: 15 });
    await prisma.attendance.create({
      data: { gymId: owner.gymId, memberId: away.id, checkedInAt: addDays(new Date(), -12) },
    });

    const regular = await addMember(owner.gymId, { name: "Regular", phone: "03009990000" });
    await addMembership(owner.gymId, regular.id, { expiresInDays: 15 });
    await prisma.attendance.create({
      data: { gymId: owner.gymId, memberId: regular.id, checkedInAt: addDays(new Date(), -1) },
    });

    // Expired: the renewals list's business, not this one.
    const expired = await addMember(owner.gymId, { name: "Expired", phone: "03008880000" });
    await addMembership(owner.gymId, expired.id, { expiresInDays: -3 });

    const res = await api().get("/api/attendance/inactive?days=10").set("Cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.map((m: { name: string }) => m.name)).toEqual(["Away"]);
    expect(res.body.data[0].daysAway).toBeGreaterThanOrEqual(11);

    const stricter = await api().get("/api/attendance/inactive?days=14").set("Cookie", owner.cookie);
    expect(stricter.body.data).toHaveLength(0);
  });
});

describe("lockers", () => {
  it("adds a run, assigns one per member, and frees expired holders", async () => {
    const owner = await makeGym();
    const add = await api().post("/api/lockers").set("Cookie", owner.cookie).send({ from: 1, to: 5, prefix: "A-" });
    expect(add.body).toEqual({ added: 5, skipped: 0 });
    const again = await api().post("/api/lockers").set("Cookie", owner.cookie).send({ from: 4, to: 6, prefix: "A-" });
    expect(again.body).toEqual({ added: 1, skipped: 2 });

    const list = (await api().get("/api/lockers").set("Cookie", owner.cookie)).body;
    expect(list.data.map((l: { number: string }) => l.number)).toEqual(["A-1", "A-2", "A-3", "A-4", "A-5", "A-6"]);

    const live = await addMember(owner.gymId, { name: "Live" });
    await addMembership(owner.gymId, live.id, { expiresInDays: 10 });
    const lapsed = await addMember(owner.gymId, { name: "Lapsed", phone: "03007770000" });
    await addMembership(owner.gymId, lapsed.id, { expiresInDays: -5 });

    const [l1, l2] = list.data;
    expect((await api().post(`/api/lockers/${l1.id}/assign`).set("Cookie", owner.cookie).send({ memberId: live.id })).status).toBe(200);
    expect((await api().post(`/api/lockers/${l2.id}/assign`).set("Cookie", owner.cookie).send({ memberId: live.id })).status).toBe(400);
    await api().post(`/api/lockers/${l2.id}/assign`).set("Cookie", owner.cookie).send({ memberId: lapsed.id });

    const after = (await api().get("/api/lockers").set("Cookie", owner.cookie)).body;
    expect(after.counts).toMatchObject({ total: 6, taken: 2, expired: 1 });

    const freed = await api().post("/api/lockers/release-expired").set("Cookie", owner.cookie);
    expect(freed.body).toEqual({ released: 1 });
    const final = await prisma.locker.findUniqueOrThrow({ where: { id: l2.id } });
    expect(final.memberId).toBeNull();
  });
});

describe("supplement stock and profit", () => {
  it("flags low stock per product and reports profit from the cost at sale time", async () => {
    const owner = await makeGym();
    const create = (body: Record<string, unknown>) =>
      api().post("/api/supplements").set("Cookie", owner.cookie).send({ category: "protein", ...body });
    const whey = await create({ name: "Whey", price: 10000, costPrice: 7000, stock: 10, lowStockAt: 3 });
    await create({ name: "Creatine", price: 3000, stock: 2, lowStockAt: 5 });
    expect(whey.body.costPrice).toBe(7000);

    const low = await api().get("/api/supplements/low-stock").set("Cookie", owner.cookie);
    expect(low.body.data.map((s: { name: string }) => s.name)).toEqual(["Creatine"]);

    await api().post(`/api/supplements/${whey.body.id}/sell`).set("Cookie", owner.cookie).send({ quantity: 2 });
    // A later cost change must not rewrite the margin on that sale.
    await api().put(`/api/supplements/${whey.body.id}`).set("Cookie", owner.cookie).send({ costPrice: 9000 });

    const profit = await api().get("/api/supplements/profit?months=1").set("Cookie", owner.cookie);
    expect(profit.status).toBe(200);
    expect(profit.body.data[0]).toMatchObject({ name: "Whey", unitsSold: 2, revenue: 20000, cost: 14000, profit: 6000, marginPct: 30 });

    const list = await api().get("/api/supplements").set("Cookie", owner.cookie);
    expect(list.body.counts.lowStock).toBe(1);
  });
});

describe("SMS fallback", () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.restoreAllMocks();
  });

  it("sends the receipt by SMS through the gateway when WhatsApp is not configured", async () => {
    process.env.SMS_GATEWAY_URL = "https://sms.example.pk/send?to={to}&text={message}";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    const { sendMemberMessage } = await import("../../src/services/messaging.js");
    const { templates } = await import("../../src/services/whatsapp.js");

    const result = await sendMemberMessage({
      to: "0300 1234567",
      ...templates.paymentReceipt("Ali", "Iron Gym", "Rs. 2,500", "Monthly", "1 October 2026"),
    });

    expect(result).toBe("sent");
    const [url] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("to=923001234567");
    expect(decodeURIComponent(String(url))).toContain("received Rs. 2,500 from Ali for Monthly");
  });

  it("does nothing when neither transport is configured", async () => {
    delete process.env.SMS_GATEWAY_URL;
    delete process.env.TWILIO_ACCOUNT_SID;
    const { messagingEnabled } = await import("../../src/services/messaging.js");
    expect(messagingEnabled()).toBe(false);
  });
});
