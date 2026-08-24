import { beforeEach, describe, expect, it } from 'vitest';
import prisma from '../../src/db.js';
import { addMember, addMembership, addUser, api, makeGym, resetDb } from '../helpers.js';

beforeEach(resetDb);

describe('Analytics API', () => {
  it('allows owner and accountant to view analytics, but restricts receptionist', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await addMembership(owner.gymId, member.id);

    // Record some attendance
    await prisma.attendance.create({
      data: {
        gymId: owner.gymId,
        memberId: member.id,
        checkedInAt: new Date(),
      },
    });

    const accountant = await addUser(owner.gymId, { role: 'staff', staffPermission: 'accountant' });
    const receptionist = await addUser(owner.gymId, { role: 'staff', staffPermission: 'receptionist' });

    // 1. Accountant has canViewReports = true -> gets 200
    const viewAccRes = await api()
      .get('/api/analytics/attendance')
      .set('Cookie', accountant.cookie);
    expect(viewAccRes.status).toBe(200);
    expect(viewAccRes.body.dailyTrends).toBeDefined();
    expect(viewAccRes.body.peakHours).toBeDefined();
    expect(viewAccRes.body.stats.activeMembers).toBe(1);

    // 2. Receptionist has canViewReports = false -> gets 403
    const viewRecRes = await api()
      .get('/api/analytics/attendance')
      .set('Cookie', receptionist.cookie);
    expect(viewRecRes.status).toBe(403);
  });
});
