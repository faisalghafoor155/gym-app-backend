import { beforeEach, describe, expect, it } from 'vitest';

import prisma from '../../src/db.js';
import { addMember, addMembership, makeGym, resetDb } from '../helpers.js';
import { runFingerprintRetention } from '../../src/jobs/fingerprintRetention.js';
import { encryptTemplate } from '../../src/services/fingerprint/crypto.js';
import { LAPSED_AFTER_DAYS } from '../../src/services/membership.js';

/**
 * Deleting the fingerprints of members who stopped coming.
 *
 * Two properties matter more than the arithmetic. A member who still trains
 * must never lose their enrolment — that is a working member turned away at the
 * door — and a member long gone must actually lose it, or the policy is words
 * rather than a policy. Most of what follows is one or the other.
 *
 * The default grace is 90 days on top of the 60 a member takes to lapse, so
 * "long gone" here means roughly five months. The tests state offsets relative
 * to that total rather than hard-coding 150, so changing the default does not
 * silently make them assert the wrong thing.
 */

beforeEach(resetDb);

/** Days of silence a template needs before this job will delete it. */
const RETAINED_DAYS = LAPSED_AFTER_DAYS + 90;

/** An enrolment, written the way the controller would. */
const enrol = (gymId: string, memberId: string, enrolledAt?: Date) =>
  prisma.fingerprintTemplate.create({
    data: {
      gymId,
      memberId,
      template: encryptTemplate(Buffer.from('template-bytes'), memberId),
      format: 'fake-v1',
      ...(enrolledAt ? { enrolledAt } : {}),
    },
    select: { id: true },
  });

/** How many enrolments are left, across every gym. */
const remaining = () => prisma.fingerprintTemplate.count();

/** A date `days` before midnight today. */
const daysAgo = (days: number): Date => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d;
};

describe('members who are still training', () => {
  it('keeps the enrolment of a member with a live membership', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await addMembership(owner.gymId, member.id, { expiresInDays: 30 });
    await enrol(owner.gymId, member.id);

    const run = await runFingerprintRetention();

    expect(run).toMatchObject({ due: 0, deleted: 0 });
    expect(await remaining()).toBe(1);
  });

  it('keeps the enrolment of a member who expired but has not lapsed', async () => {
    // Expired a month ago is somebody the gym still expects back, and whose
    // renewal should not cost them a trip to the enrolment desk.
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await addMembership(owner.gymId, member.id, { expiresInDays: -30 });
    await enrol(owner.gymId, member.id);

    const run = await runFingerprintRetention();

    expect(run.deleted).toBe(0);
    expect(await remaining()).toBe(1);
  });

  it('keeps the enrolment of a member lapsed but still inside the grace window', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await addMembership(owner.gymId, member.id, {
      expiresInDays: -(LAPSED_AFTER_DAYS + 10),
    });
    await enrol(owner.gymId, member.id);

    const run = await runFingerprintRetention();

    expect(run.deleted).toBe(0);
    expect(await remaining()).toBe(1);
  });

  it('keeps an enrolment on the day the window closes, and deletes it after', async () => {
    // The boundary, pinned in both directions. `isLapsed` needs *more* than
    // LAPSED_AFTER_DAYS to have passed, and this job inherits that, so an
    // expiry exactly on the total is still inside the window.
    const owner = await makeGym();
    const onBoundary = await addMember(owner.gymId, { name: 'On the line' });
    await addMembership(owner.gymId, onBoundary.id, { expiresInDays: -RETAINED_DAYS });
    await enrol(owner.gymId, onBoundary.id);

    expect((await runFingerprintRetention()).deleted).toBe(0);
    expect(await remaining()).toBe(1);

    const past = await addMember(owner.gymId, { name: 'One day over' });
    await addMembership(owner.gymId, past.id, { expiresInDays: -(RETAINED_DAYS + 1) });
    await enrol(owner.gymId, past.id);

    const run = await runFingerprintRetention();

    expect(run.deleted).toBe(1);
    // The boundary member's row is the one still standing.
    const left = await prisma.fingerprintTemplate.findMany({ select: { memberId: true } });
    expect(left).toEqual([{ memberId: onBoundary.id }]);
  });

  it('keeps a member who lapsed once but has since renewed', async () => {
    // The old membership is still on the row and still long expired. What
    // decides is that a live one exists beside it.
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await addMembership(owner.gymId, member.id, {
      expiresInDays: -(RETAINED_DAYS + 30),
      status: 'superseded',
    });
    await addMembership(owner.gymId, member.id, { expiresInDays: 30 });
    await enrol(owner.gymId, member.id);

    const run = await runFingerprintRetention();

    expect(run).toMatchObject({ due: 0, deleted: 0 });
    expect(await remaining()).toBe(1);
  });
});

describe('members who have gone', () => {
  it('deletes the enrolment of a member long past the window', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await addMembership(owner.gymId, member.id, {
      expiresInDays: -(RETAINED_DAYS + 60),
    });
    await enrol(owner.gymId, member.id);

    const run = await runFingerprintRetention();

    expect(run).toMatchObject({ due: 1, deleted: 1, alreadyGone: 0 });
    expect(await remaining()).toBe(0);
  });

  it('deletes the enrolment of a member deactivated by hand', async () => {
    // Somebody has already decided this member is off the roster.
    const owner = await makeGym();
    const member = await addMember(owner.gymId, { status: 'inactive' });
    await addMembership(owner.gymId, member.id, { expiresInDays: -30 });
    await enrol(owner.gymId, member.id);

    const run = await runFingerprintRetention();

    expect(run.deleted).toBe(1);
    expect(await remaining()).toBe(0);
  });

  it('lets a hand deactivation outrank a membership still running', async () => {
    // The one case where this job deletes despite live dates. Staff marking
    // somebody inactive is an explicit decision, and it beats the calendar for
    // the same reason `effectiveMemberStatus` lets a stored `inactive` win: a
    // renewal must not quietly undo it.
    const owner = await makeGym();
    const member = await addMember(owner.gymId, { status: 'inactive' });
    await addMembership(owner.gymId, member.id, { expiresInDays: 30 });
    await enrol(owner.gymId, member.id);

    const run = await runFingerprintRetention();

    expect(run.deleted).toBe(1);
    expect(await remaining()).toBe(0);
  });

  it('deletes an old enrolment for a member who never bought anything', async () => {
    // No membership at all, so there is no expiry to count from and the
    // enrolment's own age stands in. These are the templates with the least
    // reason to exist, and leaving them out would be the wrong kind of caution.
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await enrol(owner.gymId, member.id, daysAgo(RETAINED_DAYS + 30));

    const run = await runFingerprintRetention();

    expect(run.deleted).toBe(1);
    expect(await remaining()).toBe(0);
  });

  it('keeps a fresh enrolment for a member who has not bought anything yet', async () => {
    // Mid-signup: enrolled at the desk a minute before the plan is rung up.
    // Deleting this would break the flow it belongs to.
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await enrol(owner.gymId, member.id);

    const run = await runFingerprintRetention();

    expect(run).toMatchObject({ due: 0, deleted: 0 });
    expect(await remaining()).toBe(1);
  });

  it('deletes only the template, leaving the member and their history', async () => {
    // The narrowness is the point: biometrics get a shorter life than the
    // gym's own commercial record of the same person.
    const owner = await makeGym();
    const member = await addMember(owner.gymId, { name: 'Ali Khan' });
    await addMembership(owner.gymId, member.id, {
      expiresInDays: -(RETAINED_DAYS + 30),
    });
    await enrol(owner.gymId, member.id);

    await runFingerprintRetention();

    const stillThere = await prisma.member.findUnique({
      where: { id: member.id },
      select: { name: true, memberNo: true },
    });
    expect(stillThere?.name).toBe('Ali Khan');
    expect(stillThere?.memberNo).toBeTruthy();
    expect(await prisma.membership.count({ where: { memberId: member.id } })).toBe(1);
  });
});

describe('the record it leaves', () => {
  it('writes an audit entry naming the member', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId, { name: 'Ali Khan' });
    await addMembership(owner.gymId, member.id, {
      expiresInDays: -(RETAINED_DAYS + 30),
    });
    await enrol(owner.gymId, member.id);

    await runFingerprintRetention();

    const log = await prisma.auditLog.findFirst({
      where: { action: 'fingerprint.retention' },
    });
    expect(log?.entityId).toBe(member.id);
    // Readable without a lookup, which matters most once the row it describes
    // is gone.
    expect(log?.entityLabel).toBe('Ali Khan');
    expect(log?.gymId).toBe(owner.gymId);
    expect(log?.reason).toContain('automatically');
  });

  it('never copies the template into the audit trail', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await addMembership(owner.gymId, member.id, {
      expiresInDays: -(RETAINED_DAYS + 30),
    });
    await prisma.fingerprintTemplate.create({
      data: {
        gymId: owner.gymId,
        memberId: member.id,
        template: encryptTemplate(Buffer.from('secret-biometric'), member.id),
        format: 'fake-v1',
      },
    });

    await runFingerprintRetention();

    const log = await prisma.auditLog.findFirst({
      where: { action: 'fingerprint.retention' },
    });
    // Deleting biometric data must not be the moment a copy of it is written
    // somewhere built for reading.
    expect(JSON.stringify(log)).not.toContain('secret-biometric');
  });
});

describe('running it more than once', () => {
  it('is harmless on a second run', async () => {
    // A restart, a redeploy, or a second backend instance all re-run this.
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await addMembership(owner.gymId, member.id, {
      expiresInDays: -(RETAINED_DAYS + 30),
    });
    await enrol(owner.gymId, member.id);

    expect((await runFingerprintRetention()).deleted).toBe(1);

    const second = await runFingerprintRetention();
    expect(second).toMatchObject({ due: 0, deleted: 0, alreadyGone: 0 });
    // One audit row, not two: the second run found nothing to do rather than
    // logging a deletion that did not happen.
    expect(
      await prisma.auditLog.count({ where: { action: 'fingerprint.retention' } }),
    ).toBe(1);
  });
});

describe('across gyms', () => {
  it('deletes each gym\'s own expired enrolments and no others', async () => {
    const mine = await makeGym();
    const theirs = await makeGym({ gymName: 'Other Gym' });

    const myGone = await addMember(mine.gymId, { name: 'Mine, gone' });
    await addMembership(mine.gymId, myGone.id, { expiresInDays: -(RETAINED_DAYS + 30) });
    await enrol(mine.gymId, myGone.id);

    const theirActive = await addMember(theirs.gymId, { name: 'Theirs, training' });
    await addMembership(theirs.gymId, theirActive.id, { expiresInDays: 30 });
    await enrol(theirs.gymId, theirActive.id);

    const run = await runFingerprintRetention();

    expect(run.deleted).toBe(1);
    const left = await prisma.fingerprintTemplate.findMany({ select: { gymId: true } });
    expect(left).toEqual([{ gymId: theirs.gymId }]);
    // The audit row belongs to the gym whose member it was.
    const log = await prisma.auditLog.findFirst({
      where: { action: 'fingerprint.retention' },
    });
    expect(log?.gymId).toBe(mine.gymId);
  });
});
