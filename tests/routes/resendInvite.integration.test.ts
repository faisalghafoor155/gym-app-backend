import { beforeEach, describe, expect, it } from 'vitest';

import prisma from '../../src/db.js';
import { addUser, api, makeGym, resetDb } from '../helpers.js';

/**
 * Inviting staff when the first invite went nowhere.
 *
 * The link always comes back to the owner so it can go out on WhatsApp, the
 * team list says who is still waiting on theirs, and "Resend invite" issues a
 * new link that replaces the old one.
 */

beforeEach(resetDb);

const invite = async (cookie: string, email = 'helper@example.com') => {
  const res = await api().post('/api/users/staff').set('Cookie', cookie)
    .send({ name: 'Helper', email, staffPermission: 'receptionist' });
  expect(res.status).toBe(201);
  return res.body as { id: string; invite: { emailed: boolean; link: string } };
};

const tokenOf = (link: string) => new URL(link).searchParams.get('token')!;

describe('staff invites', () => {
  it('hands the owner the link to pass on', async () => {
    const owner = await makeGym();

    const { invite: inv } = await invite(owner.cookie);

    expect(inv.link).toMatch(/\/accept-invite\?token=/);
  });

  it('marks an account that has not set its password as pending', async () => {
    const owner = await makeGym();
    await invite(owner.cookie);

    const res = await api().get('/api/users').set('Cookie', owner.cookie);

    const helper = res.body.users.find((u: { email: string }) => u.email === 'helper@example.com');
    expect(helper.invitePending).toBe(true);
    expect(helper).not.toHaveProperty('passwordHash');
  });

  it('issues a new link that replaces the old one', async () => {
    const owner = await makeGym();
    const created = await invite(owner.cookie);

    const res = await api().post(`/api/users/${created.id}/invite`).set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    const fresh = tokenOf(res.body.invite.link);
    expect(fresh).not.toBe(tokenOf(created.invite.link));

    const stale = await api().post('/api/auth/accept-invite')
      .send({ token: tokenOf(created.invite.link), password: 'a-new-password-123' });
    expect(stale.status).toBe(400);

    const ok = await api().post('/api/auth/accept-invite')
      .send({ token: fresh, password: 'a-new-password-123' });
    expect(ok.status).toBe(200);
  });

  it('refuses to re-invite an account that already has a password', async () => {
    const owner = await makeGym();
    const staff = await addUser(owner.gymId, { role: 'staff' });

    const res = await api().post(`/api/users/${staff.userId}/invite`).set('Cookie', owner.cookie);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already has a password/);
  });

  it('does not reach into another gym', async () => {
    const owner = await makeGym();
    const other = await makeGym();
    const created = await invite(other.cookie, 'elsewhere@example.com');

    const res = await api().post(`/api/users/${created.id}/invite`).set('Cookie', owner.cookie);

    expect(res.status).toBe(404);
    const user = await prisma.user.findUnique({ where: { id: created.id } });
    expect(user?.inviteTokenHash).not.toBeNull();
  });
});
