/** @format */

import { describe, it, expect, beforeEach } from "vitest";

import prisma from "../../src/db.js";
import { addDays } from "../../src/services/membership.js";
import { api, resetDb, makeGym, addMember, addPlan } from "../helpers.js";

/**
 * Renewing: selling the next period and taking the money for it in one go.
 *
 * Never automatic — a membership sits expired until somebody at the desk
 * collects the fee and presses the button. The pairing is the point: a renewal
 * that granted the days but lost the receipt would leave the books claiming
 * the gym was never paid, so the two are written in one transaction or not at
 * all.
 */

beforeEach(resetDb);

/** A member whose membership expires `inDays` from now. Negative for one that
 *  has already run out. */
const memberDueForRenewal = async (
  gymId: string,
  opts: { inDays?: number; price?: number } = {},
) => {
  const { inDays = 0, price = 2500 } = opts;
  const member = await addMember(gymId);
  const plan = await addPlan(gymId, { price });
  const expiryDate = addDays(new Date(), inDays);

  const membership = await prisma.membership.create({
    data: {
      gymId,
      memberId: member.id,
      planId: plan.id,
      startDate: addDays(expiryDate, -plan.durationDays),
      expiryDate,
      pricePaid: price,
      status: "active",
    },
    select: { id: true },
  });

  return { member, plan, membership, expiryDate };
};

const renew = (
  gymId: string,
  cookie: string,
  ids: { memberId: string; membershipId: string },
  body: Record<string, unknown>,
) =>
  api()
    .post(`/api/members/${ids.memberId}/memberships/${ids.membershipId}/renew`)
    .set("Cookie", cookie)
    .send(body);

describe("POST /members/:id/memberships/:membershipId/renew", () => {
  it("sells the next period and records the payment together", async () => {
    const owner = await makeGym();
    const { member, membership } = await memberDueForRenewal(owner.gymId);

    const res = await renew(
      owner.gymId,
      owner.cookie,
      { memberId: member.id, membershipId: membership.id },
      { amount: 2500, method: "cash" },
    );

    expect(res.status).toBe(201);

    const memberships = await prisma.membership.findMany({
      where: { memberId: member.id },
      orderBy: { createdAt: "asc" },
    });
    expect(memberships).toHaveLength(2);
    // The old term steps aside rather than being edited — two rows is what
    // makes the member's history answerable later.
    expect(memberships[0].status).toBe("superseded");
    expect(memberships[1].status).toBe("active");

    const payment = await prisma.payment.findFirstOrThrow({
      where: { memberId: member.id },
    });
    expect(payment.amount.toNumber()).toBe(2500);
    expect(payment.status).toBe("paid");
    // Linked to the term it bought, not left floating.
    expect(payment.membershipId).toBe(memberships[1].id);
  });

  it("carries the days still left rather than burning them", async () => {
    const owner = await makeGym();
    const { member, membership, expiryDate } = await memberDueForRenewal(
      owner.gymId,
      { inDays: 5 },
    );

    const res = await renew(
      owner.gymId,
      owner.cookie,
      { memberId: member.id, membershipId: membership.id },
      { amount: 2500, method: "cash" },
    );

    // Renewing five days early must not cost the member those five days.
    const start = new Date(res.body.startDate);
    expect(start.toDateString()).toBe(addDays(expiryDate, 1).toDateString());
  });

  it("starts today when the membership has already lapsed", async () => {
    const owner = await makeGym();
    const { member, membership } = await memberDueForRenewal(owner.gymId, {
      inDays: -20,
    });

    const res = await renew(
      owner.gymId,
      owner.cookie,
      { memberId: member.id, membershipId: membership.id },
      { amount: 2500, method: "cash" },
    );

    // Backdating into the gap would sell days that have already gone by.
    const start = new Date(res.body.startDate);
    expect(start.toDateString()).toBe(new Date().toDateString());
  });

  it("records the wallet an online renewal came through", async () => {
    const owner = await makeGym();
    const { member, membership } = await memberDueForRenewal(owner.gymId);

    await renew(
      owner.gymId,
      owner.cookie,
      { memberId: member.id, membershipId: membership.id },
      { amount: 2500, method: "online", channel: "jazzcash", reference: "TX-9" },
    );

    const payment = await prisma.payment.findFirstOrThrow({
      where: { memberId: member.id },
    });
    expect(payment.channel).toBe("jazzcash");
    expect(payment.reference).toBe("TX-9");
  });

  it("refuses a cash renewal that claims a wallet", async () => {
    const owner = await makeGym();
    const { member, membership } = await memberDueForRenewal(owner.gymId);

    const res = await renew(
      owner.gymId,
      owner.cookie,
      { memberId: member.id, membershipId: membership.id },
      { amount: 2500, method: "cash", channel: "easypaisa" },
    );

    expect(res.status).toBe(400);
  });

  it("refuses a renewal with no money against it", async () => {
    const owner = await makeGym();
    const { member, membership } = await memberDueForRenewal(owner.gymId);

    const res = await renew(
      owner.gymId,
      owner.cookie,
      { memberId: member.id, membershipId: membership.id },
      { method: "cash" },
    );

    expect(res.status).toBe(400);
    // Nothing granted, because nothing was paid.
    expect(await prisma.membership.count({ where: { memberId: member.id } })).toBe(1);
  });

  it("refuses a zero-rupee renewal", async () => {
    const owner = await makeGym();
    const { member, membership } = await memberDueForRenewal(owner.gymId);

    const res = await renew(
      owner.gymId,
      owner.cookie,
      { memberId: member.id, membershipId: membership.id },
      { amount: 0, method: "cash" },
    );

    expect(res.status).toBe(400);
  });

  it("takes a discounted amount rather than the list price", async () => {
    const owner = await makeGym();
    const { member, membership } = await memberDueForRenewal(owner.gymId, {
      price: 2500,
    });

    await renew(
      owner.gymId,
      owner.cookie,
      { memberId: member.id, membershipId: membership.id },
      { amount: 2000, method: "cash" },
    );

    const payment = await prisma.payment.findFirstOrThrow({
      where: { memberId: member.id },
    });
    // What was actually taken, not what the price list says.
    expect(payment.amount.toNumber()).toBe(2000);
  });

  it("renews onto a different plan when one is named", async () => {
    const owner = await makeGym();
    const { member, membership } = await memberDueForRenewal(owner.gymId);
    const annual = await addPlan(owner.gymId, {
      name: "Annual",
      price: 25000,
      durationDays: 365,
    });

    const res = await renew(
      owner.gymId,
      owner.cookie,
      { memberId: member.id, membershipId: membership.id },
      { planId: annual.id, amount: 25000, method: "cash" },
    );

    expect(res.status).toBe(201);
    expect(res.body.planName).toBe("Annual");
    expect(res.body.durationDays).toBe(365);
  });

  it("still renews a member whose plan has since been retired", async () => {
    const owner = await makeGym();
    const { member, membership, plan } = await memberDueForRenewal(owner.gymId);
    await prisma.membershipPlan.update({
      where: { id: plan.id },
      data: { isActive: false },
    });

    const res = await renew(
      owner.gymId,
      owner.cookie,
      { memberId: member.id, membershipId: membership.id },
      { amount: 2500, method: "cash" },
    );

    // Retiring a plan must not strand the members already on it.
    expect(res.status).toBe(201);
  });

  it("refuses moving onto a plan the gym no longer offers", async () => {
    const owner = await makeGym();
    const { member, membership } = await memberDueForRenewal(owner.gymId);
    const retired = await addPlan(owner.gymId, { name: "Old Deal" });
    await prisma.membershipPlan.update({
      where: { id: retired.id },
      data: { isActive: false },
    });

    const res = await renew(
      owner.gymId,
      owner.cookie,
      { memberId: member.id, membershipId: membership.id },
      { planId: retired.id, amount: 2500, method: "cash" },
    );

    expect(res.status).toBe(400);
  });

  it("refuses to renew a membership already superseded", async () => {
    const owner = await makeGym();
    const { member, membership } = await memberDueForRenewal(owner.gymId);
    await prisma.membership.update({
      where: { id: membership.id },
      data: { status: "superseded" },
    });

    const res = await renew(
      owner.gymId,
      owner.cookie,
      { memberId: member.id, membershipId: membership.id },
      { amount: 2500, method: "cash" },
    );

    // Renewing from closed history would branch a second live membership off
    // a row a newer one already replaced.
    expect(res.status).toBe(400);
  });

  it("does not reach into another gym's membership", async () => {
    const a = await makeGym();
    const b = await makeGym({ gymName: "Other Gym" });
    const { member, membership } = await memberDueForRenewal(a.gymId);

    const res = await renew(
      b.gymId,
      b.cookie,
      { memberId: member.id, membershipId: membership.id },
      { amount: 2500, method: "cash" },
    );

    expect(res.status).toBe(404);
  });

  it("leaves nothing behind when the payment is rejected", async () => {
    const owner = await makeGym();
    const { member, membership } = await memberDueForRenewal(owner.gymId);

    await renew(
      owner.gymId,
      owner.cookie,
      { memberId: member.id, membershipId: membership.id },
      { amount: -100, method: "cash" },
    );

    // The old membership must still be the live one.
    const memberships = await prisma.membership.findMany({
      where: { memberId: member.id },
    });
    expect(memberships).toHaveLength(1);
    expect(memberships[0].status).toBe("active");
    expect(await prisma.payment.count({ where: { memberId: member.id } })).toBe(0);
  });
});

describe("removed routes", () => {
  // `resume` and `freeze` used to be listed here too. Both exist again —
  // freeze now leaves a MembershipFreeze row and an audit entry behind, and is
  // covered in retentionFeatures.integration.test.ts. Extending a membership
  // by a free number of days still is not a thing the app does.
  it.each(["extend"])("no longer answers /%s", async (action) => {
    const owner = await makeGym();
    const { member, membership } = await memberDueForRenewal(owner.gymId);

    const res = await api()
      .post(`/api/members/${member.id}/memberships/${membership.id}/${action}`)
      .set("Cookie", owner.cookie)
      .send({ days: 7, reason: "should not work" });

    expect(res.status).toBe(404);
  });

  it("refuses to resume a membership that is running normally", async () => {
    const owner = await makeGym();
    const { member, membership } = await memberDueForRenewal(owner.gymId);

    const res = await api()
      .post(`/api/members/${member.id}/memberships/${membership.id}/resume`)
      .set("Cookie", owner.cookie);

    // 400 rather than 404: the route exists now, but resuming is only
    // meaningful for something actually suspended.
    expect(res.status).toBe(400);
  });
});
