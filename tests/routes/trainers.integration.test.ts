import { beforeEach, describe, expect, it } from 'vitest';
import prisma from '../../src/db.js';
import { addMember, api, makeGym, resetDb } from '../helpers.js';

beforeEach(resetDb);

describe('Trainers & PT Bookings API', () => {
  it('allows manager to create, read, update, and soft delete trainers', async () => {
    const owner = await makeGym();
    
    // 1. Create trainer
    const createRes = await api()
      .post('/api/trainers')
      .set('Cookie', owner.cookie)
      .send({
        name: 'Zain Iqbal',
        phone: '03001234567',
        specialization: 'Bodybuilding',
        commissionPercentage: 40,
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.name).toBe('Zain Iqbal');
    expect(createRes.body.commissionPercentage).toBe(40);

    const trainerId = createRes.body.id;

    // 2. Get trainers list
    const listRes = await api()
      .get('/api/trainers')
      .set('Cookie', owner.cookie);

    expect(listRes.status).toBe(200);
    expect(listRes.body.length).toBe(1);
    expect(listRes.body[0].name).toBe('Zain Iqbal');

    // 3. Update trainer
    const updateRes = await api()
      .put(`/api/trainers/${trainerId}`)
      .set('Cookie', owner.cookie)
      .send({
        name: 'Zain Iqbal (Senior)',
        commissionPercentage: 45,
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.name).toBe('Zain Iqbal (Senior)');
    expect(updateRes.body.commissionPercentage).toBe(45);

    // 4. Soft delete (deactivate) trainer
    const deleteRes = await api()
      .delete(`/api/trainers/${trainerId}`)
      .set('Cookie', owner.cookie);

    expect(deleteRes.status).toBe(200);

    const dbTrainer = await prisma.trainer.findUnique({
      where: { id: trainerId },
    });
    expect(dbTrainer?.isActive).toBe(false);
  });

  it('allows logging a PT session and calculates snaps commission and logs payment if paid', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    // Create trainer with 30% commission
    const trainer = await prisma.trainer.create({
      data: {
        gymId: owner.gymId,
        name: 'Hamza Malik',
        commissionPercentage: 30,
      },
    });

    // 1. Log a paid PT session
    const ptDate = new Date();
    const bookRes = await api()
      .post('/api/pt-sessions')
      .set('Cookie', owner.cookie)
      .send({
        memberId: member.id,
        trainerId: trainer.id,
        sessionDate: ptDate,
        priceCharged: 4000,
        status: 'completed',
        paymentStatus: 'paid',
      });

    expect(bookRes.status).toBe(201);
    expect(bookRes.body.priceCharged).toBe(4000);
    expect(bookRes.body.trainerCommission).toBe(1200); // 30% of 4000
    expect(bookRes.body.status).toBe('completed');
    expect(bookRes.body.paymentStatus).toBe('paid');

    // Verify a payment record of type 'other' was created
    const payments = await prisma.payment.findMany({
      where: { gymId: owner.gymId, memberId: member.id },
    });
    expect(payments.length).toBe(1);
    expect(payments[0].type).toBe('other');
    expect(Number(payments[0].amount)).toBe(4000);
    expect(payments[0].status).toBe('paid');

    // 2. Fetch commissions report
    const reportRes = await api()
      .get('/api/pt-sessions/commissions')
      .set('Cookie', owner.cookie);

    expect(reportRes.status).toBe(200);
    expect(reportRes.body.length).toBe(1);
    expect(reportRes.body[0].trainerName).toBe('Hamza Malik');
    expect(reportRes.body[0].totalSessions).toBe(1);
    expect(reportRes.body[0].totalRevenue).toBe(4000);
    expect(reportRes.body[0].totalCommission).toBe(1200);
  });
});
