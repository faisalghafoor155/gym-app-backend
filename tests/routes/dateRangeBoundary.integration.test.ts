/** @format */

import { describe, it, expect, beforeEach } from "vitest";

import prisma from "../../src/db.js";
import { endOfDayUtc } from "../../src/services/dates.js";
import { api, resetDb, makeGym, addMember } from "../helpers.js";

/**
 * The closing day of a date range.
 *
 * `?to=2026-08-31` names a day, not the instant it began — so everything
 * recorded during the 31st has to fall inside the range. Getting this wrong is
 * invisible in the worst way: the report still renders, it is just quietly
 * short, which reads as "we took less this month" rather than as a bug.
 *
 * The trap is the timezone. A date-only string is parsed as UTC midnight, so
 * stretching it to *local* end-of-day lands short of the real one by the
 * server's offset — five hours in Pakistan, losing everything after 7pm.
 * These tests use late-evening UTC timestamps precisely because that is the
 * window a local-time stretch drops.
 */

beforeEach(resetDb);

/** Late on the closing day: inside the range, but outside a local-time one. */
const LATE_ON_THE_LAST_DAY = new Date("2026-08-31T22:30:00.000Z");
const RANGE = "from=2026-08-01&to=2026-08-31";

describe("endOfDayUtc", () => {
  it("stretches a date-only value to the real end of that day", () => {
    // The date as Zod hands it over: UTC midnight.
    expect(endOfDayUtc(new Date("2026-08-31")).toISOString())
      .toBe("2026-08-31T23:59:59.999Z");
  });

  it("does not depend on where the server happens to be", () => {
    // The bug this replaced produced 18:59:59Z on a UTC+5 host. Asserting the
    // exact instant is what keeps the fix from regressing on a machine whose
    // clock is set differently from CI's.
    const end = endOfDayUtc(new Date("2026-01-15"));
    expect(end.getUTCHours()).toBe(23);
    expect(end.getUTCMinutes()).toBe(59);
    expect(end.getUTCDate()).toBe(15);
  });
});

describe("payments — the closing day of a range", () => {
  const paymentLateOnTheLastDay = async (gymId: string) => {
    const member = await addMember(gymId);
    await prisma.payment.create({
      data: {
        gymId,
        memberId: member.id,
        amount: 2500,
        method: "cash",
        status: "paid",
        type: "membership",
        paymentDate: LATE_ON_THE_LAST_DAY,
      },
    });
  };

  it("includes a payment taken late on the closing day", async () => {
    const owner = await makeGym();
    await paymentLateOnTheLastDay(owner.gymId);

    const res = await api()
      .get(`/api/payments?${RANGE}`)
      .set("Cookie", owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("counts it in the totals, not just the rows", async () => {
    const owner = await makeGym();
    await paymentLateOnTheLastDay(owner.gymId);

    const res = await api()
      .get(`/api/payments?${RANGE}`)
      .set("Cookie", owner.cookie);

    // The tiles above the table say "matching filters". A row that shows in
    // the list but not the total is the worse half of this bug.
    expect(res.body.collected).toBe(2500);
  });

  it("carries it into the export", async () => {
    const owner = await makeGym();
    await paymentLateOnTheLastDay(owner.gymId);

    const res = await api()
      .get(`/api/payments/export/csv?${RANGE}`)
      .set("Cookie", owner.cookie);

    expect(res.status).toBe(200);
    expect(res.text).toContain("2500");
  });

  it("still leaves out the day after", async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await prisma.payment.create({
      data: {
        gymId: owner.gymId,
        memberId: member.id,
        amount: 2500,
        method: "cash",
        status: "paid",
        type: "membership",
        paymentDate: new Date("2026-09-01T00:30:00.000Z"),
      },
    });

    const res = await api()
      .get(`/api/payments?${RANGE}`)
      .set("Cookie", owner.cookie);

    // Stretching to the end of the closing day must not spill into the next.
    expect(res.body.data).toHaveLength(0);
  });
});

describe("expenses — the closing day of a range", () => {
  const expenseLateOnTheLastDay = (gymId: string) =>
    prisma.expense.create({
      data: {
        gymId,
        category: "rent",
        amount: 85000,
        spentOn: LATE_ON_THE_LAST_DAY,
      },
    });

  it("includes an expense recorded late on the closing day", async () => {
    const owner = await makeGym();
    await expenseLateOnTheLastDay(owner.gymId);

    const res = await api()
      .get(`/api/expenses?${RANGE}`)
      .set("Cookie", owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("counts it against the month's profit", async () => {
    const owner = await makeGym();
    await expenseLateOnTheLastDay(owner.gymId);

    const res = await api()
      .get(`/api/expenses/profit?${RANGE}`)
      .set("Cookie", owner.cookie);

    expect(res.status).toBe(200);
    // An expense missing from the profit report overstates what the gym made.
    expect(res.body.expenses).toBe(85000);
  });

  it("still leaves out the day after", async () => {
    const owner = await makeGym();
    await prisma.expense.create({
      data: {
        gymId: owner.gymId,
        category: "rent",
        amount: 85000,
        spentOn: new Date("2026-09-01T00:30:00.000Z"),
      },
    });

    const res = await api()
      .get(`/api/expenses?${RANGE}`)
      .set("Cookie", owner.cookie);

    expect(res.body.data).toHaveLength(0);
  });
});
