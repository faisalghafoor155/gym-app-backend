import { beforeEach, describe, expect, it } from 'vitest';
import prisma from '../../src/db.js';
import { addMember, addUser, api, makeGym, resetDb } from '../helpers.js';

beforeEach(resetDb);

describe('Online Payments & Renewals API', () => {
  it('allows members to fetch plans and pay their outstanding dues online', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    
    // Create member user login
    const memberAccount = await addUser(owner.gymId, { role: 'member', memberId: member.id });

    // Create a plan
    await prisma.membershipPlan.create({
      data: {
        gymId: owner.gymId,
        name: 'Standard Plan',
        price: 2000,
        durationDays: 30,
        isActive: true,
      },
    });

    // Create a due payment for this member
    const duePayment = await prisma.payment.create({
      data: {
        gymId: owner.gymId,
        memberId: member.id,
        amount: 1500,
        status: 'due',
        method: 'cash',
      },
    });

    // 1. Get available plans
    const plansRes = await api()
      .get('/api/online-payments/plans')
      .set('Cookie', memberAccount.cookie);

    expect(plansRes.status).toBe(200);
    expect(plansRes.body.length).toBeGreaterThan(0);

    // 2. Pay dues online
    const checkoutRes = await api()
      .post('/api/online-payments/checkout')
      .set('Cookie', memberAccount.cookie)
      .send({
        type: 'due',
        paymentId: duePayment.id,
      });

    expect(checkoutRes.status).toBe(200);
    expect(checkoutRes.body.success).toBe(true);

    // Verify database payment status
    const paidPayment = await prisma.payment.findUnique({
      where: { id: duePayment.id },
    });
    expect(paidPayment?.status).toBe('paid');
    expect(paidPayment?.method).toBe('online');
  });

  it('allows members to renew their membership online and chains the start date if active', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    
    // Create member user login
    const memberAccount = await addUser(owner.gymId, { role: 'member', memberId: member.id });

    // Create a plan
    const plan = await prisma.membershipPlan.create({
      data: {
        gymId: owner.gymId,
        name: 'Premium Plan',
        price: 3000,
        durationDays: 30,
        isActive: true,
      },
    });

    // 1. First renewal (starts today)
    const renew1 = await api()
      .post('/api/online-payments/checkout')
      .set('Cookie', memberAccount.cookie)
      .send({
        type: 'renew',
        planId: plan.id,
      });

    expect(renew1.status).toBe(201);
    expect(renew1.body.success).toBe(true);
    const firstMembership = renew1.body.membership;

    // 2. Second renewal (should chain after the first membership expiryDate!)
    const renew2 = await api()
      .post('/api/online-payments/checkout')
      .set('Cookie', memberAccount.cookie)
      .send({
        type: 'renew',
        planId: plan.id,
      });

    expect(renew2.status).toBe(201);
    expect(renew2.body.success).toBe(true);
    const secondMembership = renew2.body.membership;

    // The start date of the second membership should equal the expiry date of the first membership!
    const firstExpiry = new Date(firstMembership.expiryDate).toISOString();
    const secondStart = new Date(secondMembership.startDate).toISOString();
    expect(secondStart).toBe(firstExpiry);
  });
});
