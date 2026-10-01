import { beforeEach, describe, expect, it } from 'vitest';
import prisma from '../../src/db.js';
import { addMember, api, makeGym, resetDb } from '../helpers.js';
import { ENTITLEMENTS } from '../../src/services/subscription.js';
import { hasDevice } from '../../src/services/fingerprint/index.js';
import { hasLiveGateway } from '../../src/services/gateways/index.js';

beforeEach(resetDb);

/**
 * What a gym's subscription actually stops it doing.
 *
 * The table itself is unit-tested in `services/subscription.test.ts`; this is
 * about the enforcement — that the limits hold at the endpoints, that a
 * refusal says enough to act on, and that the things deliberately left open on
 * a downgrade stay open.
 *
 * Every gym here names its tier. The helper defaults to `pro` precisely so
 * that tests about something else are never stopped by a plan, which makes a
 * test that says `plan: 'free'` a test that means it.
 */

const staffPayload = (n: number) => ({
  name: `Helper ${n}`,
  email: `helper-${n}-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.com`,
  password: 'correct-horse-battery',
  staffPermission: 'receptionist' as const,
});

describe('the member limit', () => {
  it('refuses the one past the ceiling, and says what would hold it', async () => {
    // Free allows 50. Forty-nine already on the books leaves room for one.
    const owner = await makeGym({ plan: 'free' });
    for (let i = 0; i < 49; i++) {
      await addMember(owner.gymId, { name: `Member ${i}`, phone: null as never });
    }

    const fits = await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'Number fifty' });
    expect(fits.status).toBe(201);

    const over = await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'Number fifty-one' });

    // 409, not 403: the gym can clear this itself, and a client has to be able
    // to tell "make room" from "you are not allowed".
    expect(over.status).toBe(409);
    expect(over.body.reason).toBe('plan_limit');
    expect(over.body.of).toBe('members');
    expect(over.body.upgradeTo).toBe('basic');
    // The way out that does not cost money is in the message too.
    expect(over.body.error).toContain('inactive');
  });

  it('counts active members only, so retiring one frees a place', async () => {
    const owner = await makeGym({ plan: 'free' });
    for (let i = 0; i < 50; i++) {
      await addMember(owner.gymId, { name: `Member ${i}`, phone: null as never });
    }

    const full = await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'Turned away' });
    expect(full.status).toBe(409);

    // Somebody who stopped coming is marked inactive rather than deleted —
    // which is the whole reason the limit counts active members.
    const lapsed = await prisma.member.findFirstOrThrow({
      where: { gymId: owner.gymId },
    });
    await prisma.member.update({
      where: { id: lapsed.id },
      data: { status: 'inactive' },
    });

    const now = await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'Fits now' });
    expect(now.status).toBe(201);
  });

  it('leaves an uncapped tier alone', async () => {
    const owner = await makeGym({ plan: 'pro' });
    for (let i = 0; i < 60; i++) {
      await addMember(owner.gymId, { name: `Member ${i}`, phone: null as never });
    }

    const res = await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'Sixty-one' });

    expect(res.status).toBe(201);
  });

  it('burns no member number on a refusal', async () => {
    const owner = await makeGym({ plan: 'free' });
    for (let i = 0; i < 50; i++) {
      await addMember(owner.gymId, { name: `Member ${i}`, phone: null as never });
    }

    const before = await prisma.gym.findUniqueOrThrow({
      where: { id: owner.gymId },
      select: { memberSeq: true },
    });

    await api()
      .post('/api/members')
      .set('Cookie', owner.cookie)
      .send({ name: 'Turned away' });

    // The claim is taken inside the transaction, before the sequence is
    // incremented, so a refusal rolls the whole thing back rather than leaving
    // a gap in the gym's member numbers.
    const after = await prisma.gym.findUniqueOrThrow({
      where: { id: owner.gymId },
      select: { memberSeq: true },
    });
    expect(after.memberSeq).toBe(before.memberSeq);
  });

  it('imports the rows that fit and says how many did not', async () => {
    const owner = await makeGym({ plan: 'free' });
    for (let i = 0; i < 48; i++) {
      await addMember(owner.gymId, { name: `Member ${i}`, phone: null as never });
    }

    const csv = [
      'name,email,phone,gender,dateOfBirth,address,emergencyContact',
      ...Array.from(
        { length: 5 },
        (_, i) => `Imported ${i},,,,,,`,
      ),
    ].join('\n');

    const res = await api()
      .post('/api/members/import')
      .set('Cookie', owner.cookie)
      .send({ csv });

    expect(res.status).toBe(200);
    // Two places left, so two rows land and the file is not rejected outright.
    expect(res.body.created).toBe(2);
    expect(res.body.errors.join(' ')).toContain('3 of 5 rows were not imported');
  });
});

describe('the staff seat limit', () => {
  it('follows the plan rather than a fixed number', async () => {
    // Free allows two. This used to be six for every gym, whatever it paid.
    const owner = await makeGym({ plan: 'free' });

    for (let i = 0; i < 2; i++) {
      const res = await api()
        .post('/api/users/staff')
        .set('Cookie', owner.cookie)
        .send(staffPayload(i));
      expect(res.status, `seat ${i + 1}`).toBe(201);
    }

    const over = await api()
      .post('/api/users/staff')
      .set('Cookie', owner.cookie)
      .send(staffPayload(3));

    expect(over.status).toBe(409);
    expect(over.body.reason).toBe('plan_limit');
    expect(over.body.of).toBe('staff');
    // The surprising part of this limit, kept from the old message.
    expect(over.body.error).toContain('revoked accounts still hold theirs');
  });

  it('still gives basic the six seats every gym used to have', async () => {
    const owner = await makeGym({ plan: 'basic' });

    for (let i = 0; i < 6; i++) {
      const res = await api()
        .post('/api/users/staff')
        .set('Cookie', owner.cookie)
        .send(staffPayload(i));
      expect(res.status, `seat ${i + 1}`).toBe(201);
    }

    const seventh = await api()
      .post('/api/users/staff')
      .set('Cookie', owner.cookie)
      .send(staffPayload(7));
    expect(seventh.status).toBe(409);
  });

  it('reports the seats it has left, uncapped as null', async () => {
    const free = await makeGym({ plan: 'free' });
    const listed = await api().get('/api/users').set('Cookie', free.cookie);
    expect(listed.body.seats).toEqual({ limit: 2, used: 0, remaining: 2 });
  });
});

describe('the trainer and class limits', () => {
  it('caps trainers, and frees a place when one is deactivated', async () => {
    const owner = await makeGym({ plan: 'free' });

    for (let i = 0; i < 2; i++) {
      const res = await api()
        .post('/api/trainers')
        .set('Cookie', owner.cookie)
        .send({ name: `Coach ${i}`, commissionPercentage: 10 });
      expect(res.status).toBe(201);
    }

    const over = await api()
      .post('/api/trainers')
      .set('Cookie', owner.cookie)
      .send({ name: 'Third coach', commissionPercentage: 10 });
    expect(over.status).toBe(409);
    expect(over.body.of).toBe('trainers');

    // `DELETE` deactivates rather than deletes, and the limit counts active
    // trainers — so retiring one is how a gym makes room without paying.
    const first = await prisma.trainer.findFirstOrThrow({
      where: { gymId: owner.gymId },
    });
    await api().delete(`/api/trainers/${first.id}`).set('Cookie', owner.cookie);

    const now = await api()
      .post('/api/trainers')
      .set('Cookie', owner.cookie)
      .send({ name: 'Third coach', commissionPercentage: 10 });
    expect(now.status).toBe(201);
  });

  it('caps the class catalogue but not the timetable built from it', async () => {
    const owner = await makeGym({ plan: 'free' });

    for (let i = 0; i < 3; i++) {
      const res = await api()
        .post('/api/classes')
        .set('Cookie', owner.cookie)
        .send({ name: `Class ${i}` });
      expect(res.status).toBe(201);
    }

    const over = await api()
      .post('/api/classes')
      .set('Cookie', owner.cookie)
      .send({ name: 'Fourth class' });
    expect(over.status).toBe(409);

    // Schedules are what a class is for. Capping them would cap how often a
    // gym may run what it already pays to offer.
    const cls = await prisma.class.findFirstOrThrow({
      where: { gymId: owner.gymId },
    });
    for (const day of [1, 2, 3, 4, 5]) {
      const res = await api()
        .post('/api/classes/schedules')
        .set('Cookie', owner.cookie)
        .send({
          classId: cls.id,
          dayOfWeek: day,
          startTime: '09:00',
          endTime: '10:00',
          capacity: 20,
        });
      expect(res.status, `day ${day}`).toBe(201);
    }
  });
});

describe('feature gating', () => {
  it('refuses reports with 402, not 403', async () => {
    const owner = await makeGym({ plan: 'free' });

    const res = await api()
      .get('/api/analytics/attendance')
      .set('Cookie', owner.cookie);

    // 402 rather than 403: the owner is entitled to reports, the gym has not
    // bought them. Only one of those has an upgrade button under it.
    expect(res.status).toBe(402);
    expect(res.body.reason).toBe('plan_feature');
    expect(res.body.feature).toBe('analytics');
    expect(res.body.upgradeTo).toBe('basic');
  });

  it('lets a tier that includes it through', async () => {
    const owner = await makeGym({ plan: 'basic' });

    const res = await api()
      .get('/api/analytics/attendance')
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
  });

  it('refuses enrolling a fingerprint on a tier without biometrics', async () => {
    const owner = await makeGym({ plan: 'basic' });
    const member = await addMember(owner.gymId);

    const res = await api()
      .post('/api/fingerprint/enroll')
      .set('Cookie', owner.cookie)
      .send({
        memberId: member.id,
        template: Buffer.from('a template').toString('base64'),
      });

    expect(res.status).toBe(402);
    expect(res.body.feature).toBe('biometrics');
  });

  it('still answers the fingerprint status, saying why it is unavailable', async () => {
    const owner = await makeGym({ plan: 'free' });

    const res = await api()
      .get('/api/fingerprint/status')
      .set('Cookie', owner.cookie);

    // Ungated on purpose. A 402 here would leave the Attendance tab unable to
    // tell "no reader plugged in" from "not on your plan" — the two things
    // this endpoint exists to distinguish.
    expect(res.status).toBe(200);
    expect(res.body.licensed).toBe(false);
    expect(res.body.plan).toBe('free');
  });

  it('never stands between a member and deleting their fingerprint', async () => {
    // Enrolled while the gym was on Pro, then downgraded — the templates stay
    // in the database, and removing one must not need an upgrade.
    const owner = await makeGym({ plan: 'pro' });
    const member = await addMember(owner.gymId);
    await prisma.fingerprintTemplate.create({
      data: {
        memberId: member.id,
        gymId: owner.gymId,
        template: Buffer.from('encrypted'),
        format: 'test',
      },
    });
    await prisma.gym.update({
      where: { id: owner.gymId },
      data: { plan: 'free' },
    });

    const res = await api()
      .delete(`/api/fingerprint/${member.id}`)
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(204);
    expect(
      await prisma.fingerprintTemplate.count({ where: { gymId: owner.gymId } }),
    ).toBe(0);
  });

  it('offers a front-desk request instead of gateways it cannot use', async () => {
    const owner = await makeGym({ plan: 'basic' });
    const member = await addMember(owner.gymId);
    const memberAccount = await prisma.user.create({
      data: {
        gymId: owner.gymId,
        email: `member-${Date.now()}@example.com`,
        name: 'Member account',
        role: 'member',
        memberId: member.id,
      },
    });

    const res = await api()
      .get('/api/online-payments/providers')
      .set('Cookie', (await import('../helpers.js')).cookieFor(memberAccount.id));

    expect(res.status).toBe(200);
    // Rendering a gateway button that `checkout` then refuses is worse than
    // offering the flow every gym has: ask to renew, pay at the desk.
    expect(res.body).toHaveLength(1);
    expect(res.body[0].provider).toBe('manual');
  });
});

describe('GET /subscription', () => {
  it('reports the tier, its usage, and what every tier holds', async () => {
    const owner = await makeGym({ plan: 'free' });
    await addMember(owner.gymId, { phone: null as never });
    await addMember(owner.gymId, { name: 'Second', phone: null as never });

    const res = await api().get('/api/subscription').set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body.plan).toBe('free');
    expect(res.body.planLabel).toBe('Free');
    expect(res.body.limits.members).toEqual({ limit: 50, used: 2, remaining: 48 });
    expect(res.body.features.whatsapp).toBe(false);

    // The whole table travels too, so an upgrade prompt can name what the next
    // tier holds without the client keeping its own copy of the pricing.
    expect(res.body.plans).toHaveLength(4);
    expect(res.body.plans.map((p: { plan: string }) => p.plan)).toEqual([
      'free',
      'basic',
      'growth',
      'pro',
    ]);
  });

  it('reports an uncapped limit as null rather than a number', async () => {
    const owner = await makeGym({ plan: 'pro' });

    const res = await api().get('/api/subscription').set('Cookie', owner.cookie);

    expect(res.body.limits.members).toEqual({
      limit: null,
      used: 0,
      remaining: null,
    });
  });

  it('is readable by staff, who are the ones who hit the limits', async () => {
    const owner = await makeGym({ plan: 'free' });
    const staff = await prisma.user.create({
      data: {
        gymId: owner.gymId,
        email: `staff-${Date.now()}@example.com`,
        name: 'Front desk',
        role: 'staff',
        staffPermission: 'receptionist',
      },
    });

    const res = await api()
      .get('/api/subscription')
      .set('Cookie', (await import('../helpers.js')).cookieFor(staff.id));

    // A receptionist who cannot add the 51st member needs to be told why.
    expect(res.status).toBe(200);
  });
});

describe('gyms that existed before plans', () => {
  it('start on free only when nothing says otherwise', async () => {
    // The schema default. The migration moved every *existing* gym to basic
    // instead — see the migration for why — but a gym created from here on
    // starts on the trial tier.
    const gym = await prisma.gym.create({
      data: { name: 'Brand new', ownerName: 'Someone' },
    });
    expect(gym.plan).toBe('free');
  });

  it('were moved to a tier that takes nothing away from them', async () => {
    // The migration's choice of `basic`, pinned here because it is a decision
    // rather than a detail: the tier existing gyms land on has to be one whose
    // features they already had, or the deploy quietly switches something off
    // at a gym that was using it.
    //
    // Read from the entitlements table rather than restated, so adding a
    // feature to a higher tier cannot silently make this assertion stale.
    const landing = ENTITLEMENTS.basic.features;

    // Nothing reachable today is withheld. Biometrics needs a driver in
    // `services/fingerprint` and online payments needs a configured gateway;
    // neither exists, which is what makes `basic` safe to land on. If either
    // ships, this test is the place that says the migration needs revisiting.
    expect(hasDevice()).toBe(false);
    expect(hasLiveGateway()).toBe(false);

    // What the app *did* do for every gym before plans existed: staff seats,
    // and nothing else gated.
    expect(ENTITLEMENTS.basic.limits.staff).toBe(6);
    expect(landing.whatsapp).toBe(true);
    expect(landing.analytics).toBe(true);
  });
});
