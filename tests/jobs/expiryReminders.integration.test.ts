import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

import prisma from '../../src/db.js';
import { addMember, addMembership, addPlan, makeGym, resetDb } from '../helpers.js';
import { runExpiryReminders } from '../../src/jobs/expiryReminders.js';
import * as mail from '../../src/services/mail.js';

/**
 * The daily expiry reminder.
 *
 * The interesting property is not that it sends — it is that running it twice
 * does not. A restart, a redeploy or a second backend instance all re-run this
 * job, and a member who gets the same notice three times learns to ignore the
 * first one next month. Most of what follows is about that.
 *
 * `sendMail` is stubbed throughout: these tests are about who gets told and how
 * often, not about SMTP. The transport itself is exercised nowhere in the suite
 * and is documented as such.
 */

beforeEach(resetDb);
afterEach(() => { vi.restoreAllMocks(); });

/** Stubs the transport as configured and working, and reports what it took. */
const stubMail = () => {
  vi.spyOn(mail, 'mailEnabled', 'get').mockReturnValue(true);
  return vi.spyOn(mail, 'sendMail').mockResolvedValue(true);
};

/** A gym with one member whose membership expires today. */
const gymWithExpiringMember = async (opts: { email?: string | null } = {}) => {
  const { email = 'member@example.com' } = opts;
  const owner = await makeGym({ gymName: 'Iron House' });
  const member = await addMember(owner.gymId, { name: 'Ali Khan' });
  if (email !== undefined) {
    await prisma.member.update({ where: { id: member.id }, data: { email } });
  }
  const plan = await addPlan(owner.gymId, { name: 'Monthly' });
  const membership = await addMembership(owner.gymId, member.id, {
    planId: plan.id,
    expiresInDays: 0,
  });
  return { owner, member, plan, membership };
};

describe('expiry reminders — who gets one', () => {
  it('tells a member whose membership expires today', async () => {
    const send = stubMail();
    await gymWithExpiringMember();

    const run = await runExpiryReminders();

    expect(run).toMatchObject({ due: 1, sent: 1, failed: 0 });
    expect(send).toHaveBeenCalledOnce();
    const [sent] = send.mock.calls[0]!;
    expect(sent.to).toBe('member@example.com');
    expect(sent.subject).toContain('Iron House');
    // The plan is named because a member who has bought more than one thing
    // needs to know which of them ran out.
    expect(sent.text).toContain('Monthly');
    expect(sent.text).toContain('Ali');
  });

  it('says nothing to a membership expiring tomorrow', async () => {
    const send = stubMail();
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await prisma.member.update({ where: { id: member.id }, data: { email: 'a@b.com' } });
    await addMembership(owner.gymId, member.id, { expiresInDays: 1 });

    const run = await runExpiryReminders();

    expect(run.due).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('says nothing to one that expired yesterday', async () => {
    const send = stubMail();
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await prisma.member.update({ where: { id: member.id }, data: { email: 'a@b.com' } });
    await addMembership(owner.gymId, member.id, { expiresInDays: -1 });

    await runExpiryReminders();

    // Chasing the already-lapsed is a decision about how often a gym emails
    // its members, and is deliberately not this job's to make.
    expect(send).not.toHaveBeenCalled();
  });

  it('skips a member with no address on file', async () => {
    const send = stubMail();
    await gymWithExpiringMember({ email: null });

    const run = await runExpiryReminders();

    // Counted, not silently dropped: a gym whose members mostly have no email
    // should be able to see that from the log line.
    expect(run).toMatchObject({ due: 1, sent: 0, skippedNoEmail: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it('skips a member somebody deactivated by hand', async () => {
    const send = stubMail();
    const { member } = await gymWithExpiringMember();
    await prisma.member.update({ where: { id: member.id }, data: { status: 'inactive' } });

    await runExpiryReminders();

    expect(send).not.toHaveBeenCalled();
  });

  it('ignores a cancelled membership that happens to end today', async () => {
    const send = stubMail();
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await prisma.member.update({ where: { id: member.id }, data: { email: 'a@b.com' } });
    await addMembership(owner.gymId, member.id, { expiresInDays: 0, status: 'cancelled' });

    const run = await runExpiryReminders();

    expect(run.due).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores a superseded membership, which the renewal already replaced', async () => {
    const send = stubMail();
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await prisma.member.update({ where: { id: member.id }, data: { email: 'a@b.com' } });
    const plan = await addPlan(owner.gymId);
    // The old one ends today; the renewal runs for another month.
    await addMembership(owner.gymId, member.id, {
      planId: plan.id, expiresInDays: 0, status: 'superseded',
    });
    await addMembership(owner.gymId, member.id, { planId: plan.id, expiresInDays: 30 });

    await runExpiryReminders();

    // Asking somebody to renew what they just renewed is the one message that
    // makes the gym look like it is not paying attention.
    expect(send).not.toHaveBeenCalled();
  });

  it('reaches members in every gym, each named its own', async () => {
    const send = stubMail();
    const a = await makeGym({ gymName: 'Gym A' });
    const b = await makeGym({ gymName: 'Gym B' });
    for (const [gym, email] of [[a, 'a@x.com'], [b, 'b@x.com']] as const) {
      const m = await addMember(gym.gymId);
      await prisma.member.update({ where: { id: m.id }, data: { email } });
      await addMembership(gym.gymId, m.id, { expiresInDays: 0 });
    }

    const run = await runExpiryReminders();

    expect(run.sent).toBe(2);
    const subjects = send.mock.calls.map(([m]) => m.subject);
    expect(subjects.some(s => s.includes('Gym A'))).toBe(true);
    expect(subjects.some(s => s.includes('Gym B'))).toBe(true);
  });
});

describe('expiry reminders — sent exactly once', () => {
  it('does not send again when the job runs twice in a day', async () => {
    const send = stubMail();
    await gymWithExpiringMember();

    const first = await runExpiryReminders();
    const second = await runExpiryReminders();

    expect(first.sent).toBe(1);
    // A redeploy at noon must not re-notify everybody who was told at nine.
    expect(second).toMatchObject({ due: 1, sent: 0, skippedAlreadySent: 1 });
    expect(send).toHaveBeenCalledOnce();
  });

  it('survives two instances running it at the same moment', async () => {
    const send = stubMail();
    await gymWithExpiringMember();

    // Fired together, so both read the same empty ReminderLog before either
    // writes. Only the unique constraint decides this.
    const runs = await Promise.all([
      runExpiryReminders(),
      runExpiryReminders(),
      runExpiryReminders(),
    ]);

    expect(runs.reduce((n, r) => n + r.sent, 0)).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    expect(await prisma.reminderLog.count()).toBe(1);
  });

  it('records what was sent and where', async () => {
    stubMail();
    const { membership } = await gymWithExpiringMember();

    await runExpiryReminders();

    const log = await prisma.reminderLog.findFirstOrThrow();
    expect(log).toMatchObject({
      membershipId: membership.id,
      kind: 'membershipExpiry',
      sentTo: 'member@example.com',
    });
  });

  it('reminds again about a different membership expiring later', async () => {
    const send = stubMail();
    const { owner, member, plan } = await gymWithExpiringMember();

    await runExpiryReminders();

    // A renewal that itself runs out a month later is a separate membership,
    // and a separate thing to be told about.
    const renewal = await addMembership(owner.gymId, member.id, {
      planId: plan.id, expiresInDays: 30,
    });
    await prisma.membership.update({
      where: { id: renewal.id },
      data: { expiryDate: new Date(new Date().setHours(12, 0, 0, 0)) },
    });

    const second = await runExpiryReminders();

    expect(second.sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('expiry reminders — when mail fails', () => {
  it('gives the claim back so tomorrow tries again', async () => {
    vi.spyOn(mail, 'mailEnabled', 'get').mockReturnValue(true);
    const send = vi.spyOn(mail, 'sendMail').mockResolvedValue(false);
    await gymWithExpiringMember();

    const run = await runExpiryReminders();

    expect(run).toMatchObject({ sent: 0, failed: 1 });
    // Keeping the claim would mean one unreachable mail server silently costs
    // a member their only notice.
    expect(await prisma.reminderLog.count()).toBe(0);

    send.mockResolvedValue(true);
    const retry = await runExpiryReminders();
    expect(retry.sent).toBe(1);
  });

  it('keeps the claim when there is no transport at all', async () => {
    vi.spyOn(mail, 'mailEnabled', 'get').mockReturnValue(false);
    vi.spyOn(mail, 'sendMail').mockResolvedValue(false);
    await gymWithExpiringMember();

    const first = await runExpiryReminders();
    const second = await runExpiryReminders();

    // With no transport `sendMail` logs and reports false every time, so
    // releasing the claim would reprint the same notice on every run for ever.
    expect(first.failed).toBe(1);
    expect(second.skippedAlreadySent).toBe(1);
  });

  it('carries on after one member fails', async () => {
    vi.spyOn(mail, 'mailEnabled', 'get').mockReturnValue(true);
    const send = vi.spyOn(mail, 'sendMail')
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    const owner = await makeGym();
    for (const email of ['one@x.com', 'two@x.com', 'three@x.com']) {
      const m = await addMember(owner.gymId);
      await prisma.member.update({ where: { id: m.id }, data: { email } });
      await addMembership(owner.gymId, m.id, { expiresInDays: 0 });
    }

    const run = await runExpiryReminders();

    // One bad address must not cost everybody else their notice.
    expect(send).toHaveBeenCalledTimes(3);
    expect(run).toMatchObject({ due: 3, sent: 2, failed: 1 });
  });
});

describe('expiry reminders — the clock', () => {
  it('treats a membership expiring late today as due today', async () => {
    const send = stubMail();
    const { membership } = await gymWithExpiringMember();
    // 23:30 — inside today, but after any hour the job would plausibly run.
    const late = new Date();
    late.setHours(23, 30, 0, 0);
    await prisma.membership.update({
      where: { id: membership.id },
      data: { expiryDate: late },
    });

    const run = await runExpiryReminders(new Date(new Date().setHours(9, 0, 0, 0)));

    expect(run.sent).toBe(1);
    expect(send).toHaveBeenCalledOnce();
  });

  it('takes its day from the injected clock, not the wall', async () => {
    const send = stubMail();
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await prisma.member.update({ where: { id: member.id }, data: { email: 'a@b.com' } });
    await addMembership(owner.gymId, member.id, { expiresInDays: 5 });

    // Run as though it were five days from now.
    const then = new Date();
    then.setDate(then.getDate() + 5);
    then.setHours(9, 0, 0, 0);
    const run = await runExpiryReminders(then);

    expect(run.sent).toBe(1);
    expect(send).toHaveBeenCalledOnce();
  });
});
