import { beforeEach, describe, expect, it } from 'vitest';
import prisma from '../../src/db.js';
import { addMember, api, makeGym, resetDb } from '../helpers.js';

beforeEach(resetDb);

describe('Gym Classes & Timetables API', () => {
  it('allows manager to create class programs and schedule weekly slots', async () => {
    const owner = await makeGym();

    // 1. Create a class program
    const classRes = await api()
      .post('/api/classes')
      .set('Cookie', owner.cookie)
      .send({
        name: 'Yoga Vinyasa',
        description: 'Vinyasa flow for intermediate practitioners',
      });

    expect(classRes.status).toBe(201);
    expect(classRes.body.name).toBe('Yoga Vinyasa');

    const classId = classRes.body.id;

    // 2. Schedule a weekly slot
    const scheduleRes = await api()
      .post('/api/classes/schedules')
      .set('Cookie', owner.cookie)
      .send({
        classId,
        dayOfWeek: 2, // Tuesday
        startTime: '18:00',
        endTime: '19:00',
        capacity: 15,
      });

    expect(scheduleRes.status).toBe(201);
    expect(scheduleRes.body.dayOfWeek).toBe(2);
    expect(scheduleRes.body.capacity).toBe(15);

    const scheduleId = scheduleRes.body.id;

    // 3. Get schedules list
    const listRes = await api()
      .get('/api/classes/schedules')
      .set('Cookie', owner.cookie);

    expect(listRes.status).toBe(200);
    expect(listRes.body.length).toBe(1);
    expect(listRes.body[0].className).toBe('Yoga Vinyasa');

    // 4. Delete schedule slot
    const deleteRes = await api()
      .delete(`/api/classes/schedules/${scheduleId}`)
      .set('Cookie', owner.cookie);

    expect(deleteRes.status).toBe(200);

    const dbSchedule = await prisma.classSchedule.findUnique({
      where: { id: scheduleId },
    });
    expect(dbSchedule?.isActive).toBe(false);
  });

  it('validates booking limits and enforces capacity constraint on slot reservations', async () => {
    const owner = await makeGym();
    const member1 = await addMember(owner.gymId);
    const member2 = await addMember(owner.gymId);
    const member3 = await addMember(owner.gymId);

    // Create a class
    const program = await prisma.class.create({
      data: {
        gymId: owner.gymId,
        name: 'Zumba Cardio',
      },
    });

    // Create schedule slot with capacity = 2 on Tuesday (dayOfWeek = 2)
    const schedule = await prisma.classSchedule.create({
      data: {
        gymId: owner.gymId,
        classId: program.id,
        dayOfWeek: 2,
        startTime: '18:00',
        endTime: '19:00',
        capacity: 2,
      },
    });

    // We book on a Tuesday date
    const bookingDate = new Date('2026-08-18'); // August 18, 2026 is Tuesday!

    // 1. Book member 1
    const book1 = await api()
      .post('/api/class-bookings')
      .set('Cookie', owner.cookie)
      .send({
        scheduleId: schedule.id,
        memberId: member1.id,
        bookingDate,
      });
    expect(book1.status).toBe(201);

    // 2. Book member 2
    const book2 = await api()
      .post('/api/class-bookings')
      .set('Cookie', owner.cookie)
      .send({
        scheduleId: schedule.id,
        memberId: member2.id,
        bookingDate,
      });
    expect(book2.status).toBe(201);

    // 3. Book member 3 (must fail because capacity = 2 is exceeded)
    const book3 = await api()
      .post('/api/class-bookings')
      .set('Cookie', owner.cookie)
      .send({
        scheduleId: schedule.id,
        memberId: member3.id,
        bookingDate,
      });
    expect(book3.status).toBe(400);
    expect(book3.body.error).toContain('fully booked');
  });
});

describe('a schedule that could not happen', () => {
  const aClass = async (cookie: string): Promise<string> => {
    const res = await api().post('/api/classes').set('Cookie', cookie).send({ name: 'Yoga' });
    return res.body.id;
  };

  const schedule = (cookie: string, classId: string, over: Record<string, unknown> = {}) =>
    api().post('/api/classes/schedules').set('Cookie', cookie).send({
      classId, dayOfWeek: 1, startTime: '09:00', endTime: '10:00', capacity: 10, ...over,
    });

  it('refuses one that ends before it starts', async () => {
    const owner = await makeGym();
    const classId = await aClass(owner.cookie);

    const res = await schedule(owner.cookie, classId, { startTime: '18:00', endTime: '09:00' });

    // Nothing enforced this, so a typo produced a slot of negative length and
    // the timetable looked broken rather than wrong.
    expect(res.status).toBe(400);
    expect(await prisma.classSchedule.count()).toBe(0);
  });

  it('refuses one that ends the moment it starts', async () => {
    const owner = await makeGym();
    const classId = await aClass(owner.cookie);

    const res = await schedule(owner.cookie, classId, { startTime: '09:00', endTime: '09:00' });

    expect(res.status).toBe(400);
  });

  it('accepts an unpadded hour, comparing it by the clock', async () => {
    const owner = await makeGym();
    const classId = await aClass(owner.cookie);

    // '9:00' sorts after '10:00' as plain text; padded, it does not.
    const res = await schedule(owner.cookie, classId, { startTime: '9:00', endTime: '10:00' });

    expect(res.status).toBe(201);
  });

  it('refuses a day of the week that does not exist', async () => {
    const owner = await makeGym();
    const classId = await aClass(owner.cookie);

    expect((await schedule(owner.cookie, classId, { dayOfWeek: 7 })).status).toBe(400);
    expect((await schedule(owner.cookie, classId, { dayOfWeek: -1 })).status).toBe(400);
  });

  it('refuses a class nobody could attend', async () => {
    const owner = await makeGym();
    const classId = await aClass(owner.cookie);

    expect((await schedule(owner.cookie, classId, { capacity: 0 })).status).toBe(400);
  });

  it('refuses a time that is not one', async () => {
    const owner = await makeGym();
    const classId = await aClass(owner.cookie);

    expect((await schedule(owner.cookie, classId, { startTime: '25:00' })).status).toBe(400);
    expect((await schedule(owner.cookie, classId, { startTime: '6pm' })).status).toBe(400);
  });
});
