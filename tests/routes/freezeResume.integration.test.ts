import { beforeEach, describe, expect, it } from 'vitest';
import prisma from '../../src/db.js';
import { addMember, addMembership, addPlan, api, makeGym, resetDb } from '../helpers.js';

beforeEach(resetDb);

describe('Membership Freeze & Resume API', () => {
  it('allows owner/authorized staff to freeze and resume a membership', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const plan = await addPlan(owner.gymId, { durationDays: 30 });
    
    // Create an active membership
    const membership = await prisma.membership.create({
      data: {
        gymId: owner.gymId,
        memberId: member.id,
        planId: plan.id,
        startDate: new Date(),
        expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        originalExpiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        pricePaid: 2500,
        status: 'active',
      },
    });

    // 1. Freeze membership
    const freezeRes = await api()
      .post(`/api/members/${member.id}/memberships/${membership.id}/freeze`)
      .set('Cookie', owner.cookie);

    expect(freezeRes.status).toBe(200);
    expect(freezeRes.body.status).toBe('suspended');
    
    const dbMembershipAfterFreeze = await prisma.membership.findUnique({
      where: { id: membership.id },
    });
    expect(dbMembershipAfterFreeze?.status).toBe('suspended');
    expect(dbMembershipAfterFreeze?.freezeStartDate).not.toBeNull();

    // 2. Resume membership
    const resumeRes = await api()
      .post(`/api/members/${member.id}/memberships/${membership.id}/resume`)
      .set('Cookie', owner.cookie);

    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.status).toBe('active');

    const dbMembershipAfterResume = await prisma.membership.findUnique({
      where: { id: membership.id },
    });
    expect(dbMembershipAfterResume?.status).toBe('active');
    expect(dbMembershipAfterResume?.freezeStartDate).toBeNull();
    // Expiry date must have shifted forward (extended by at least 1 day because Math.max(1, ...) handles same-day resume)
    expect(new Date(dbMembershipAfterResume!.expiryDate).getTime())
      .toBeGreaterThan(new Date(membership.expiryDate).getTime());
  });

  it('refuses to freeze a membership that is not active', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const plan = await addPlan(owner.gymId, { durationDays: 30 });
    
    const membership = await prisma.membership.create({
      data: {
        gymId: owner.gymId,
        memberId: member.id,
        planId: plan.id,
        startDate: new Date(),
        expiryDate: new Date(),
        originalExpiryDate: new Date(),
        pricePaid: 2500,
        status: 'cancelled',
      },
    });

    const res = await api()
      .post(`/api/members/${member.id}/memberships/${membership.id}/freeze`)
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(400);
  });
});
