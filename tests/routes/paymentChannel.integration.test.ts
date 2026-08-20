/** @format */

import { describe, it, expect, beforeEach } from "vitest";

import prisma from "../../src/db.js";
import { api, resetDb, makeGym, addMember, addPlan } from "../helpers.js";

/**
 * Recording *where* money came from, not just how much.
 *
 * `method` says cash or online; `channel` says which wallet. The pairing is
 * what the tests here defend: a cash row carrying a wallet's name is two
 * answers to one question, and whichever the reader happens to look at is the
 * one the books get reconciled against.
 */

beforeEach(resetDb);

describe("POST /api/payments — channel", () => {
  it("records the wallet an online payment came through", async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    const res = await api()
      .post("/api/payments")
      .set("Cookie", owner.cookie)
      .send({
        memberId: member.id,
        amount: 2500,
        method: "online",
        channel: "jazzcash",
        reference: "4429183756",
      });

    expect(res.status).toBe(201);
    expect(res.body.channel).toBe("jazzcash");
    expect(res.body.reference).toBe("4429183756");
  });

  it("refuses a channel on a cash payment", async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    const res = await api()
      .post("/api/payments")
      .set("Cookie", owner.cookie)
      .send({
        memberId: member.id,
        amount: 2500,
        method: "cash",
        channel: "easypaisa",
      });

    expect(res.status).toBe(400);
  });

  it("leaves a cash payment without a channel", async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    const res = await api()
      .post("/api/payments")
      .set("Cookie", owner.cookie)
      .send({ memberId: member.id, amount: 2500, method: "cash" });

    expect(res.status).toBe(201);
    expect(res.body.channel).toBeNull();
  });

  it("rejects a wallet the gym does not take", async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    const res = await api()
      .post("/api/payments")
      .set("Cookie", owner.cookie)
      .send({
        memberId: member.id,
        amount: 2500,
        method: "online",
        channel: "bitcoin",
      });

    expect(res.status).toBe(400);
  });

  it("does not invent a channel when the method is left to default", async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    // No method sent at all, so it defaults to cash — which must not keep a
    // channel that arrived alongside it.
    const res = await api()
      .post("/api/payments")
      .set("Cookie", owner.cookie)
      .send({ memberId: member.id, amount: 2500 });

    expect(res.status).toBe(201);
    expect(res.body.method).toBe("cash");
    expect(res.body.channel).toBeNull();
  });
});

describe("PUT /api/payments/:id — channel", () => {
  it("clears the wallet when an online payment is corrected to cash", async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const created = await api()
      .post("/api/payments")
      .set("Cookie", owner.cookie)
      .send({
        memberId: member.id,
        amount: 2500,
        method: "online",
        channel: "easypaisa",
        reference: "999",
      });

    const res = await api()
      .put(`/api/payments/${created.body.id}`)
      .set("Cookie", owner.cookie)
      .send({ method: "cash" });

    expect(res.status).toBe(200);
    // Left behind, the row would claim money arrived by a route it did not.
    expect(res.body.channel).toBeNull();
  });

  it("moves a payment from one wallet to another", async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const created = await api()
      .post("/api/payments")
      .set("Cookie", owner.cookie)
      .send({
        memberId: member.id,
        amount: 2500,
        method: "online",
        channel: "easypaisa",
      });

    const res = await api()
      .put(`/api/payments/${created.body.id}`)
      .set("Cookie", owner.cookie)
      .send({ method: "online", channel: "bank" });

    expect(res.body.channel).toBe("bank");
  });
});

describe("POST /api/members — fee taken at registration", () => {
  it("records the fee against the membership it bought", async () => {
    const owner = await makeGym();
    const plan = await addPlan(owner.gymId);

    const res = await api()
      .post("/api/members")
      .set("Cookie", owner.cookie)
      .send({
        name: "Ahmed Khan",
        phone: "03001234567",
        planId: plan.id,
        feeAmount: 2500,
        feeMethod: "online",
        feeChannel: "easypaisa",
        feeReference: "TX-1",
      });

    expect(res.status).toBe(201);

    const payments = await prisma.payment.findMany({
      where: { gymId: owner.gymId },
    });
    expect(payments).toHaveLength(1);
    expect(payments[0].amount.toNumber()).toBe(2500);
    expect(payments[0].channel).toBe("easypaisa");
    expect(payments[0].reference).toBe("TX-1");
    expect(payments[0].status).toBe("paid");
    // The link is what turns "this member paid 2500" into books that
    // reconcile against the membership it settled.
    expect(payments[0].membershipId).not.toBeNull();
  });

  it("records nothing when no fee was taken", async () => {
    const owner = await makeGym();
    const plan = await addPlan(owner.gymId);

    await api()
      .post("/api/members")
      .set("Cookie", owner.cookie)
      .send({ name: "Ahmed Khan", phone: "03001234567", planId: plan.id });

    expect(await prisma.payment.count({ where: { gymId: owner.gymId } })).toBe(
      0,
    );
  });

  it("takes a fee from a member who picked no plan", async () => {
    const owner = await makeGym();

    const res = await api()
      .post("/api/members")
      .set("Cookie", owner.cookie)
      .send({
        name: "Ahmed Khan",
        phone: "03001234567",
        feeAmount: 1000,
        feeMethod: "cash",
      });

    expect(res.status).toBe(201);
    const payment = await prisma.payment.findFirstOrThrow({
      where: { gymId: owner.gymId },
    });
    expect(payment.amount.toNumber()).toBe(1000);
    expect(payment.membershipId).toBeNull();
    expect(payment.channel).toBeNull();
  });

  it("refuses a cash fee that claims a wallet", async () => {
    const owner = await makeGym();

    const res = await api()
      .post("/api/members")
      .set("Cookie", owner.cookie)
      .send({
        name: "Ahmed Khan",
        phone: "03001234567",
        feeAmount: 1000,
        feeMethod: "cash",
        feeChannel: "jazzcash",
      });

    expect(res.status).toBe(400);
    // A rejected registration must leave no member behind either.
    expect(await prisma.member.count({ where: { gymId: owner.gymId } })).toBe(0);
  });

  it("puts the trainer fee through the same channel the member paid by", async () => {
    const owner = await makeGym();
    const trainer = await prisma.trainer.create({
      data: { gymId: owner.gymId, name: "Coach Bilal", ptFee: 5000 },
    });

    await api()
      .post("/api/members")
      .set("Cookie", owner.cookie)
      .send({
        name: "Ahmed Khan",
        phone: "03001234567",
        trainerId: trainer.id,
        ptFeePaid: true,
        feeAmount: 1000,
        feeMethod: "online",
        feeChannel: "jazzcash",
      });

    const ptCharge = await prisma.payment.findFirstOrThrow({
      where: { gymId: owner.gymId, notes: { startsWith: "Trainer Fee" } },
    });
    // Posting this as cash would put money in the drawer that never arrived.
    expect(ptCharge.method).toBe("online");
    expect(ptCharge.channel).toBe("jazzcash");
  });

  it("leaves an uncollected trainer fee as a plain cash due", async () => {
    const owner = await makeGym();
    const trainer = await prisma.trainer.create({
      data: { gymId: owner.gymId, name: "Coach Bilal", ptFee: 5000 },
    });

    await api()
      .post("/api/members")
      .set("Cookie", owner.cookie)
      .send({
        name: "Ahmed Khan",
        phone: "03001234567",
        trainerId: trainer.id,
        // Not paid, so it has no route yet — it must not inherit the wallet
        // the joining fee happened to come through.
        ptFeePaid: false,
        feeAmount: 1000,
        feeMethod: "online",
        feeChannel: "jazzcash",
      });

    // Matched on the note, not just the type: the joining fee on a member with
    // no plan is typed `other` too.
    const ptCharge = await prisma.payment.findFirstOrThrow({
      where: { gymId: owner.gymId, notes: { startsWith: "Trainer Fee" } },
    });
    expect(ptCharge.status).toBe("due");
    expect(ptCharge.channel).toBeNull();
  });
});

describe("gym settings — payment accounts", () => {
  it("stores and returns the accounts members send money to", async () => {
    const owner = await makeGym();

    const res = await api()
      .put("/api/gym-settings")
      .set("Cookie", owner.cookie)
      .send({
        defaultPtFee: 5000,
        easypaisaAccount: "03001234567",
        bankAccount: "Meezan Bank — PK00MEZN0001234567890",
      });

    expect(res.status).toBe(200);
    expect(res.body.easypaisaAccount).toBe("03001234567");
    expect(res.body.bankAccount).toBe("Meezan Bank — PK00MEZN0001234567890");
    // Never set, so it stays empty rather than picking up a neighbour's value.
    expect(res.body.jazzcashAccount).toBeNull();
  });

  it("clears an account when it is blanked", async () => {
    const owner = await makeGym();
    await api()
      .put("/api/gym-settings")
      .set("Cookie", owner.cookie)
      .send({ defaultPtFee: 0, jazzcashAccount: "03001234567" });

    const res = await api()
      .put("/api/gym-settings")
      .set("Cookie", owner.cookie)
      .send({ defaultPtFee: 0, jazzcashAccount: "" });

    expect(res.body.jazzcashAccount).toBeNull();
  });

  it("leaves untouched accounts alone on a partial save", async () => {
    const owner = await makeGym();
    await api()
      .put("/api/gym-settings")
      .set("Cookie", owner.cookie)
      .send({ defaultPtFee: 0, easypaisaAccount: "03001234567" });

    // A save that never mentions easypaisa must not wipe it.
    const res = await api()
      .put("/api/gym-settings")
      .set("Cookie", owner.cookie)
      .send({ defaultPtFee: 7000 });

    expect(res.body.easypaisaAccount).toBe("03001234567");
    expect(res.body.defaultPtFee).toBe(7000);
  });

  it("lets staff read the accounts so the front desk can quote them", async () => {
    const owner = await makeGym();
    await api()
      .put("/api/gym-settings")
      .set("Cookie", owner.cookie)
      .send({ defaultPtFee: 0, bankAccount: "Meezan Bank" });

    const staff = await makeGym({ role: "staff" });
    const res = await api().get("/api/gym-settings").set("Cookie", staff.cookie);

    expect(res.status).toBe(200);
  });
});
