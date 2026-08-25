import { beforeEach, describe, expect, it } from 'vitest';
import prisma from '../../src/db.js';
import { addMember, addUser, api, makeGym, resetDb } from '../helpers.js';

beforeEach(resetDb);

describe('Payouts API', () => {
  it('allows owner and accountant to view payouts and mark paid, but restricts receptionist', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    // Create trainer
    const trainer = await prisma.trainer.create({
      data: {
        gymId: owner.gymId,
        name: 'Sheraz',
        commissionPercentage: 50,
      },
    });

    // Add completed unpaid PT session
    await prisma.ptSession.create({
      data: {
        gymId: owner.gymId,
        memberId: member.id,
        trainerId: trainer.id,
        sessionDate: new Date(),
        priceCharged: 5000,
        trainerCommission: 2500,
        status: 'completed',
        paymentStatus: 'unpaid',
      },
    });

    // Create accountant and receptionist staff accounts
    const accountant = await addUser(owner.gymId, { role: 'staff', staffPermission: 'accountant' });
    const receptionist = await addUser(owner.gymId, { role: 'staff', staffPermission: 'receptionist' });

    // 1. Accountant can view payouts
    const viewAccRes = await api()
      .get('/api/payouts')
      .set('Cookie', accountant.cookie);
    expect(viewAccRes.status).toBe(200);
    expect(viewAccRes.body.length).toBe(1);
    expect(viewAccRes.body[0].trainerName).toBe('Sheraz');
    expect(viewAccRes.body[0].unpaidCommission).toBe(2500);

    // 2. Receptionist cannot view payouts (canViewPayments is true for receptionist, but wait, receptionist has canViewPayments: true. Let's make sure it checks permission)
    // Wait, let's verify if receptionist has canViewPayments in backend/src/services/permissions.ts:
    // Accountant has canViewPayments: true, Accountant can clear unpaid (canManagePayments: true).
    // Receptionist has canViewPayments: true, but not canManagePayments.
    // So receptionist can view payouts, but cannot mark payouts as paid.
    // Let's verify that!
    const viewRecRes = await api()
      .get('/api/payouts')
      .set('Cookie', receptionist.cookie);
    expect(viewRecRes.status).toBe(200);

    // 3. Receptionist cannot pay trainer (Clear Unpaid) -> gets 403
    const payRecRes = await api()
      .post(`/api/payouts/${trainer.id}/pay`)
      .set('Cookie', receptionist.cookie);
    expect(payRecRes.status).toBe(403);

    // 4. Accountant can pay trainer (Clear Unpaid) -> gets 200
    const payAccRes = await api()
      .post(`/api/payouts/${trainer.id}/pay`)
      .set('Cookie', accountant.cookie);
    expect(payAccRes.status).toBe(200);
    expect(payAccRes.body.count).toBe(1);

    // The trainer has been settled with. `payoutStatus` rather than
    // `paymentStatus`: the two were one column, and paying a trainer used to
    // also record that the member had paid the gym — see
    // ptPayouts.integration.test.ts for the pair of them kept apart.
    const updatedSession = await prisma.ptSession.findFirst({
      where: { trainerId: trainer.id },
    });
    expect(updatedSession?.payoutStatus).toBe('paid');
  });
});
