/** @format */

import { describe, it, expect, beforeEach } from "vitest";

import { api, resetDb, makeGym, addMember, addMembership } from "../helpers.js";

/**
 * Narrowing the roster to one gender.
 *
 * A filter, not a permission: everybody who could see a member before can
 * still see them, the list is just narrowed. The cases worth pinning down are
 * the ones where it must NOT narrow — no filter means everyone, including the
 * majority of rows whose gender was never recorded.
 */

beforeEach(resetDb);

const names = (body: { data: { name: string }[] }): string[] =>
  body.data.map((m) => m.name);

/** A gym with one member of each gender, plus one never recorded. */
const mixedGym = async () => {
  const owner = await makeGym();
  await addMember(owner.gymId, {
    name: "Ahmed Khan",
    gender: "male",
    phone: "03001111111",
  });
  await addMember(owner.gymId, {
    name: "Ayesha Bibi",
    gender: "female",
    phone: "03002222222",
  });
  await addMember(owner.gymId, {
    name: "Sam Taylor",
    gender: "other",
    phone: "03003333333",
  });
  await addMember(owner.gymId, {
    name: "Unrecorded Person",
    gender: null,
    phone: "03004444444",
  });
  return owner;
};

describe("members list — gender filter", () => {
  it("returns only female members when asked for them", async () => {
    const owner = await mixedGym();

    const res = await api()
      .get("/api/members?gender=female")
      .set("Cookie", owner.cookie);

    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual(["Ayesha Bibi"]);
    expect(res.body.total).toBe(1);
  });

  it("returns only male members when asked for them", async () => {
    const owner = await mixedGym();

    const res = await api()
      .get("/api/members?gender=male")
      .set("Cookie", owner.cookie);

    expect(names(res.body)).toEqual(["Ahmed Khan"]);
  });

  it("returns everyone when no gender is asked for", async () => {
    const owner = await mixedGym();

    const res = await api().get("/api/members").set("Cookie", owner.cookie);

    // Including the member with no gender on file: most older rows look like
    // that, and dropping them by default would hide most of the gym.
    expect(res.body.total).toBe(4);
  });

  it("treats a blank gender as no filter", async () => {
    const owner = await mixedGym();

    const res = await api()
      .get("/api/members?gender=")
      .set("Cookie", owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
  });

  it("never returns a member whose gender was never recorded", async () => {
    const owner = await mixedGym();

    const res = await api()
      .get("/api/members?gender=male")
      .set("Cookie", owner.cookie);

    expect(names(res.body)).not.toContain("Unrecorded Person");
  });

  it("rejects a gender that is not one of the three", async () => {
    const owner = await makeGym();

    const res = await api()
      .get("/api/members?gender=banana")
      .set("Cookie", owner.cookie);

    expect(res.status).toBe(400);
  });

  it("narrows the status tab counts too", async () => {
    const owner = await makeGym();
    const male = await addMember(owner.gymId, {
      name: "Ahmed Khan",
      gender: "male",
      phone: "03001111111",
    });
    const female = await addMember(owner.gymId, {
      name: "Ayesha Bibi",
      gender: "female",
      phone: "03002222222",
    });
    await addMembership(owner.gymId, male.id, { expiresInDays: 30 });
    await addMembership(owner.gymId, female.id, { expiresInDays: 30 });

    const res = await api()
      .get("/api/members?gender=female")
      .set("Cookie", owner.cookie);

    // A tab reading 2 above a list of 1 would send the front desk looking for
    // a member who is not there.
    expect(res.body.counts.active).toBe(1);
    expect(res.body.counts.all).toBe(1);
  });

  it("combines with a search rather than replacing it", async () => {
    const owner = await makeGym();
    await addMember(owner.gymId, {
      name: "Ayesha Bibi",
      gender: "female",
      phone: "03001111111",
    });
    await addMember(owner.gymId, {
      name: "Ayesha Khan",
      gender: "male",
      phone: "03002222222",
    });

    const res = await api()
      .get("/api/members?gender=female&search=ayesha")
      .set("Cookie", owner.cookie);

    expect(names(res.body)).toEqual(["Ayesha Bibi"]);
  });

  it("applies to the unpaged list the pickers use", async () => {
    const owner = await mixedGym();

    const res = await api()
      .get("/api/members?all=true&gender=female")
      .set("Cookie", owner.cookie);

    // `all=true` opts out of paging, not out of the filter.
    expect(names(res.body)).toEqual(["Ayesha Bibi"]);
  });

  it("still keeps one gym's members out of another's list", async () => {
    const a = await makeGym();
    const b = await makeGym({ gymName: "Other Gym" });
    await addMember(a.gymId, { name: "Ayesha Bibi", gender: "female" });

    const res = await api()
      .get("/api/members?gender=female")
      .set("Cookie", b.cookie);

    expect(res.body.total).toBe(0);
  });

  it("lets staff filter too — it is a filter, not a permission", async () => {
    const owner = await mixedGym();
    const staff = await makeGym({ role: "staff" });
    await addMember(staff.gymId, { name: "Their Member", gender: "female" });

    const res = await api()
      .get("/api/members?gender=female")
      .set("Cookie", staff.cookie);

    expect(res.status).toBe(200);
    expect(owner.gymId).not.toBe(staff.gymId);
  });
});
