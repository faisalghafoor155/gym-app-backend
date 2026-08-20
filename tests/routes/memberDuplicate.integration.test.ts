/** @format */

import { describe, it, expect, beforeEach } from "vitest";

import prisma from "../../src/db.js";
import { api, resetDb, makeGym, addMember } from "../helpers.js";

/**
 * Registration refuses to create a member who already exists.
 *
 * Two rules: the same phone line, or the same name *and* date of birth. Both
 * are scoped to one gym's active members. The cases worth holding down are the
 * ones where the rule must *not* fire — a shared blank phone, a namesake with
 * no date of birth, a member who left — because a duplicate check that is too
 * eager stops the front desk registering real people.
 */

beforeEach(resetDb);

const DOB = "1995-04-12";

describe("create — phone rule", () => {
  it("rejects a second member on the same phone", async () => {
    const owner = await makeGym();
    await addMember(owner.gymId, { name: "Ahmed Khan", phone: "03001234567" });

    const res = await api()
      .post("/api/members")
      .set("Cookie", owner.cookie)
      .send({ name: "Someone Else", phone: "03001234567" });

    expect(res.status).toBe(409);
    expect(res.body.field).toBe("phone");
    // The message has to name who it clashed with, or the front desk has
    // nowhere to go next.
    expect(res.body.existing.name).toBe("Ahmed Khan");
    expect(res.body.error).toContain("MEM-");
  });

  it("sees through formatting differences", async () => {
    const owner = await makeGym();
    await addMember(owner.gymId, { name: "Ahmed Khan", phone: "03001234567" });

    const res = await api()
      .post("/api/members")
      .set("Cookie", owner.cookie)
      .send({ name: "Someone Else", phone: "+92 300 123-4567" });

    expect(res.status).toBe(409);
  });

  it("does not burn a member number on a rejected registration", async () => {
    const owner = await makeGym();
    await addMember(owner.gymId, { phone: "03001234567" });
    const before = await prisma.gym.findUniqueOrThrow({
      where: { id: owner.gymId },
      select: { memberSeq: true },
    });

    await api()
      .post("/api/members")
      .set("Cookie", owner.cookie)
      .send({ name: "Someone Else", phone: "03001234567" });

    const after = await prisma.gym.findUniqueOrThrow({
      where: { id: owner.gymId },
      select: { memberSeq: true },
    });
    // The counter increments inside the same transaction the duplicate check
    // aborts, so a rejection must leave it where it was.
    expect(after.memberSeq).toBe(before.memberSeq);
  });

  it("lets two members share an absent phone", async () => {
    const owner = await makeGym();
    await addMember(owner.gymId, { name: "Ahmed Khan", phone: "" });

    const res = await api()
      .post("/api/members")
      .set("Cookie", owner.cookie)
      .send({ name: "Bilal Shah", phone: "" });

    expect(res.status).toBe(201);
  });

  it("does not reach into another gym", async () => {
    const a = await makeGym();
    const b = await makeGym({ gymName: "Other Gym" });
    await addMember(a.gymId, { name: "Ahmed Khan", phone: "03001234567" });

    const res = await api()
      .post("/api/members")
      .set("Cookie", b.cookie)
      .send({ name: "Ahmed Khan", phone: "03001234567" });

    expect(res.status).toBe(201);
  });

  it("ignores a member who is no longer active", async () => {
    const owner = await makeGym();
    await addMember(owner.gymId, {
      name: "Ahmed Khan",
      phone: "03001234567",
      status: "inactive",
    });

    const res = await api()
      .post("/api/members")
      .set("Cookie", owner.cookie)
      .send({ name: "Ahmed Khan", phone: "03001234567" });

    expect(res.status).toBe(201);
  });
});

describe("create — name and date of birth rule", () => {
  it("rejects the same name on the same birthday", async () => {
    const owner = await makeGym();
    await addMember(owner.gymId, {
      name: "Ahmed Khan",
      phone: "03001111111",
      dateOfBirth: new Date(`${DOB}T00:00:00.000Z`),
    });

    const res = await api()
      .post("/api/members")
      .set("Cookie", owner.cookie)
      .send({ name: "  ahmed   khan ", phone: "03002222222", dateOfBirth: DOB });

    expect(res.status).toBe(409);
    expect(res.body.field).toBe("name");
  });

  it("allows a namesake with a different date of birth", async () => {
    const owner = await makeGym();
    await addMember(owner.gymId, {
      name: "Ahmed Khan",
      phone: "03001111111",
      dateOfBirth: new Date(`${DOB}T00:00:00.000Z`),
    });

    const res = await api()
      .post("/api/members")
      .set("Cookie", owner.cookie)
      .send({ name: "Ahmed Khan", phone: "03002222222", dateOfBirth: "1990-01-01" });

    expect(res.status).toBe(201);
  });

  it("allows a namesake when neither has a date of birth", async () => {
    const owner = await makeGym();
    await addMember(owner.gymId, { name: "Muhammad Ali", phone: "03001111111" });

    // Two people of one name in a gym is ordinary. Without a birthday to
    // separate them the rule has nothing to go on and must not fire.
    const res = await api()
      .post("/api/members")
      .set("Cookie", owner.cookie)
      .send({ name: "Muhammad Ali", phone: "03002222222" });

    expect(res.status).toBe(201);
  });
});

describe("update", () => {
  it("does not find a member to be its own duplicate", async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId, {
      name: "Ahmed Khan",
      phone: "03001234567",
    });

    const res = await api()
      .put(`/api/members/${member.id}`)
      .set("Cookie", owner.cookie)
      .send({ name: "Ahmed Khan", phone: "03001234567" });

    expect(res.status).toBe(200);
  });

  it("rejects an edit onto somebody else's phone", async () => {
    const owner = await makeGym();
    await addMember(owner.gymId, { name: "Ahmed Khan", phone: "03001111111" });
    const other = await addMember(owner.gymId, {
      name: "Bilal Shah",
      phone: "03002222222",
    });

    const res = await api()
      .put(`/api/members/${other.id}`)
      .set("Cookie", owner.cookie)
      .send({ name: "Bilal Shah", phone: "03001111111" });

    expect(res.status).toBe(409);
    expect(res.body.field).toBe("phone");
  });

  it("checks the stored phone when only the name is sent", async () => {
    const owner = await makeGym();
    await addMember(owner.gymId, {
      name: "Ahmed Khan",
      phone: "03001111111",
      dateOfBirth: new Date(`${DOB}T00:00:00.000Z`),
    });
    const other = await addMember(owner.gymId, {
      name: "Bilal Shah",
      phone: "03002222222",
      dateOfBirth: new Date(`${DOB}T00:00:00.000Z`),
    });

    // Renaming Bilal to Ahmed collides on name+DOB even though the request
    // never mentions a date of birth — the check has to use the stored one.
    const res = await api()
      .put(`/api/members/${other.id}`)
      .set("Cookie", owner.cookie)
      .send({ name: "Ahmed Khan" });

    expect(res.status).toBe(409);
    expect(res.body.field).toBe("name");
  });
});

describe("GET /members/check-duplicate", () => {
  it("reports a clash without writing anything", async () => {
    const owner = await makeGym();
    await addMember(owner.gymId, { name: "Ahmed Khan", phone: "03001234567" });

    const res = await api()
      .get("/api/members/check-duplicate?phone=0300-1234567")
      .set("Cookie", owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(res.body.field).toBe("phone");
    expect(res.body.existing.name).toBe("Ahmed Khan");
    expect(await prisma.member.count({ where: { gymId: owner.gymId } })).toBe(1);
  });

  it("says so when there is no clash", async () => {
    const owner = await makeGym();
    const res = await api()
      .get("/api/members/check-duplicate?phone=03009999999")
      .set("Cookie", owner.cookie);

    expect(res.body.duplicate).toBe(false);
  });

  it("is not mistaken for a member id", async () => {
    const owner = await makeGym();
    const res = await api()
      .get("/api/members/check-duplicate")
      .set("Cookie", owner.cookie);

    // Routed to getOne, "check-duplicate" would fail id validation with a 400.
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(false);
  });

  it("excludes the member being edited", async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId, { phone: "03001234567" });

    const res = await api()
      .get(
        `/api/members/check-duplicate?phone=03001234567&excludeId=${member.id}`,
      )
      .set("Cookie", owner.cookie);

    expect(res.body.duplicate).toBe(false);
  });
});

describe("CSV import", () => {
  it("rejects a row duplicating an existing member, keeping the rest", async () => {
    const owner = await makeGym();
    await addMember(owner.gymId, { name: "Ahmed Khan", phone: "03001234567" });

    const res = await api()
      .post("/api/members/import")
      .set("Cookie", owner.cookie)
      .send({
        csv: [
          "name,phone",
          "Ahmed Khan,+92 300 1234567",
          "Bilal Shah,03007654321",
        ].join("\n"),
      });

    expect(res.status).toBe(200);
    expect(res.body.errors).toHaveLength(1);
    expect(await prisma.member.count({ where: { gymId: owner.gymId } })).toBe(2);
  });

  it("rejects a row duplicating an earlier row in the same file", async () => {
    const owner = await makeGym();

    const res = await api()
      .post("/api/members/import")
      .set("Cookie", owner.cookie)
      .send({
        csv: ["name,phone", "Ahmed Khan,03001234567", "A Khan,0300-1234567"].join(
          "\n",
        ),
      });

    expect(res.body.errors).toHaveLength(1);
    expect(await prisma.member.count({ where: { gymId: owner.gymId } })).toBe(1);
  });

  it("does not treat two rows without a phone as duplicates", async () => {
    const owner = await makeGym();

    const res = await api()
      .post("/api/members/import")
      .set("Cookie", owner.cookie)
      .send({ csv: ["name,phone", "Ahmed Khan,", "Bilal Shah,"].join("\n") });

    expect(res.body.errors ?? []).toHaveLength(0);
    expect(await prisma.member.count({ where: { gymId: owner.gymId } })).toBe(2);
  });
});
