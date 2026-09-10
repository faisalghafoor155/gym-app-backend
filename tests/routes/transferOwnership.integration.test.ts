import { beforeEach, describe, expect, it } from 'vitest';
import prisma from '../../src/db.js';
import { addMember, addUser, api, makeGym, resetDb } from '../helpers.js';

/**
 * Handing the gym to somebody else.
 *
 * The one action in the app with no way back: it demotes the caller in the
 * same transaction that promotes the target, and only an owner may call it, so
 * a transfer to the wrong account cannot be undone from inside the app. That
 * asymmetry is why every guard here is worth a case — the cost of letting one
 * through is a gym nobody can administer.
 */
beforeEach(resetDb);

const transfer = (cookie: string, userId: string) =>
  api().post('/api/users/transfer-ownership').set('Cookie', cookie).send({ userId });

describe('transfer ownership — who may receive it', () => {
  it('hands the gym to a staff account and demotes the caller', async () => {
    const owner = await makeGym();
    const staff = await addUser(owner.gymId, { role: 'staff' });

    const res = await transfer(owner.cookie, staff.userId);
    expect(res.status).toBe(200);

    const [now, before] = await Promise.all([
      prisma.user.findUnique({ where: { id: staff.userId }, select: { role: true } }),
      prisma.user.findUnique({ where: { id: owner.userId }, select: { role: true } }),
    ]);
    expect(now!.role).toBe('owner');
    expect(before!.role).toBe('staff');

    // The gym's own record follows, or the dashboard keeps naming the old owner.
    const gym = await prisma.gym.findUnique({
      where: { id: owner.gymId }, select: { ownerName: true },
    });
    expect(gym!.ownerName).toBe('staff user');
  });

  it('refuses a member portal login', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const login = await addUser(owner.gymId, { role: 'member', memberId: member.id });

    const res = await transfer(owner.cookie, login.userId);

    // Allowing this stranded the gym: the member-owner could not open their own
    // portal (the member routes refuse an owner) and the outgoing owner was
    // already staff with no permissions and a 403 on the way back.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/member account/i);

    const [target, caller] = await Promise.all([
      prisma.user.findUnique({ where: { id: login.userId }, select: { role: true } }),
      prisma.user.findUnique({ where: { id: owner.userId }, select: { role: true } }),
    ]);
    expect(target!.role).toBe('member');
    // The caller keeps the gym — a refused transfer must not demote anybody.
    expect(caller!.role).toBe('owner');
  });

  it('refuses an account in another gym', async () => {
    const owner = await makeGym();
    const other = await makeGym();

    const res = await transfer(owner.cookie, other.userId);
    expect(res.status).toBe(404);

    const stillOwner = await prisma.user.findUnique({
      where: { id: owner.userId }, select: { role: true },
    });
    expect(stillOwner!.role).toBe('owner');
  });

  it('refuses a deactivated account', async () => {
    const owner = await makeGym();
    const staff = await addUser(owner.gymId, { role: 'staff' });
    await prisma.user.update({ where: { id: staff.userId }, data: { isActive: false } });

    const res = await transfer(owner.cookie, staff.userId);
    expect(res.status).toBe(400);
  });

  it('refuses to transfer to yourself', async () => {
    const owner = await makeGym();
    const res = await transfer(owner.cookie, owner.userId);
    expect(res.status).toBe(400);
  });

  it('refuses a staff member trying to take the gym', async () => {
    const owner = await makeGym();
    const staff = await addUser(owner.gymId, { role: 'staff', staffPermission: 'manager' });

    // Even a manager, who can do everything else, cannot do this.
    const res = await transfer(staff.cookie, staff.userId);
    expect(res.status).toBe(403);

    const stillOwner = await prisma.user.findUnique({
      where: { id: owner.userId }, select: { role: true },
    });
    expect(stillOwner!.role).toBe('owner');
  });
});

describe('transfer ownership — the sessions it ends', () => {
  it('ends both accounts other sessions, and keeps the caller signed in', async () => {
    const owner = await makeGym();
    const staff = await addUser(owner.gymId, { role: 'staff' });

    // A second device for each, open before the transfer.
    const ownerElsewhere = await api().post('/api/auth/login')
      .send({ email: owner.email, password: 'correct-horse-battery' });
    const staffElsewhere = await api().post('/api/auth/login')
      .send({ email: staff.email, password: 'correct-horse-battery' });
    const ownerOld = ownerElsewhere.headers['set-cookie']![0];
    const staffOld = staffElsewhere.headers['set-cookie']![0];

    const res = await transfer(owner.cookie, staff.userId);
    expect(res.status).toBe(200);

    // Both old sessions are dead: the outgoing owner must not keep owner access
    // on another device until the token happens to expire.
    expect((await api().get('/api/users').set('Cookie', ownerOld)).status).toBe(401);
    expect((await api().get('/api/me/profile').set('Cookie', staffOld)).status).toBe(401);

    // But the browser that pressed the button stays signed in, now as staff,
    // rather than being bounced to the login page by its own action.
    const cookie = res.headers['set-cookie']?.[0];
    expect(cookie).toBeTruthy();
  });
});
