import { beforeEach, describe, expect, it } from 'vitest';

import prisma from '../../src/db.js';
import { addMember, addUser, api, makeGym, resetDb } from '../helpers.js';

/**
 * The fingerprint endpoints, with no reader attached.
 *
 * That is the state every gym is in until it buys one, so it is worth having
 * covered: the endpoints must degrade to a clear "not set up" rather than to a
 * timeout, a 500, or — worst — a check-in for somebody who was never there.
 *
 * Enrolment is tested against the database directly, because storing and
 * removing a template is device-independent by design. What a real reader adds
 * is covered by fakes in `tests/services/fingerprint.test.ts`.
 */

beforeEach(resetDb);

/** A stored enrolment, written straight in — the capture is the device's job. */
const enrol = async (gymId: string, memberId: string, format = 'fake-v1') =>
  prisma.fingerprintTemplate.create({
    data: {
      gymId,
      memberId,
      template: Buffer.from('template-bytes'),
      format,
      finger: 'right thumb',
    },
    select: { id: true },
  });

describe('GET /api/fingerprint/status', () => {
  it('reports no reader configured', async () => {
    const owner = await makeGym();

    const res = await api().get('/api/fingerprint/status').set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.online).toBe(false);
  });

  it('counts enrolments in this gym only', async () => {
    const owner = await makeGym();
    const other = await makeGym({ gymName: 'Other Gym' });
    const mine = await addMember(owner.gymId);
    const theirs = await addMember(other.gymId);
    await enrol(owner.gymId, mine.id);
    await enrol(other.gymId, theirs.id);

    const res = await api().get('/api/fingerprint/status').set('Cookie', owner.cookie);

    expect(res.body.enrolledCount).toBe(1);
  });

  it('refuses without a session', async () => {
    const res = await api().get('/api/fingerprint/status');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/fingerprint/enroll', () => {
  it('stores a template against the member', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    const res = await api().post('/api/fingerprint/enroll')
      .set('Cookie', owner.cookie)
      .send({
        memberId: member.id,
        template: Buffer.from('some-template').toString('base64'),
        format: 'fake-v1',
        finger: 'right thumb',
      });

    expect(res.status).toBe(201);
    const stored = await prisma.fingerprintTemplate.findUnique({
      where: { memberId: member.id },
    });
    expect(stored?.format).toBe('fake-v1');
    expect(stored?.finger).toBe('right thumb');
    // Stored as the bytes that arrived, not as the base64 that carried them.
    // Wrapped because Prisma hands `Bytes` back as a Uint8Array, whose own
    // `toString` prints the byte values rather than decoding them.
    expect(Buffer.from(stored!.template).toString()).toBe('some-template');
  });

  it('replaces rather than duplicating when a member enrols again', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await enrol(owner.gymId, member.id);

    const res = await api().post('/api/fingerprint/enroll')
      .set('Cookie', owner.cookie)
      .send({
        memberId: member.id,
        template: Buffer.from('second-attempt').toString('base64'),
        format: 'fake-v1',
      });

    // 200, not 201: the enrolment was updated, nothing was created.
    expect(res.status).toBe(200);
    expect(await prisma.fingerprintTemplate.count()).toBe(1);
    const stored = await prisma.fingerprintTemplate.findUnique({
      where: { memberId: member.id },
    });
    expect(Buffer.from(stored!.template).toString()).toBe('second-attempt');
  });

  it('refuses a member from another gym', async () => {
    const owner = await makeGym();
    const other = await makeGym({ gymName: 'Other Gym' });
    const theirMember = await addMember(other.gymId);

    const res = await api().post('/api/fingerprint/enroll')
      .set('Cookie', owner.cookie)
      .send({
        memberId: theirMember.id,
        template: Buffer.from('x').toString('base64'),
        format: 'fake-v1',
      });

    expect(res.status).toBe(404);
    expect(await prisma.fingerprintTemplate.count()).toBe(0);
  });

  it('rejects a template that is not base64', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    const res = await api().post('/api/fingerprint/enroll')
      .set('Cookie', owner.cookie)
      .send({ memberId: member.id, template: 'not base64!!', format: 'fake-v1' });

    expect(res.status).toBe(400);
  });

  it('is closed to a receptionist', async () => {
    // Enrolling a biometric is managing the member, not working the door.
    const owner = await makeGym();
    const desk = await addUser(owner.gymId, { staffPermission: 'receptionist' });
    const member = await addMember(owner.gymId);

    const res = await api().post('/api/fingerprint/enroll')
      .set('Cookie', desk.cookie)
      .send({
        memberId: member.id,
        template: Buffer.from('x').toString('base64'),
        format: 'fake-v1',
      });

    expect(res.status).toBe(403);
  });

  it('records the enrolment in the audit trail without the template', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    await api().post('/api/fingerprint/enroll')
      .set('Cookie', owner.cookie)
      .send({
        memberId: member.id,
        template: Buffer.from('secret-biometric').toString('base64'),
        format: 'fake-v1',
      });

    const log = await prisma.auditLog.findFirst({ where: { action: 'fingerprint.enroll' } });
    expect(log?.entityId).toBe(member.id);
    // The one piece of biometric data in the system does not get a second copy
    // in a table built for reading.
    expect(JSON.stringify(log)).not.toContain('secret-biometric');
  });
});

describe('DELETE /api/fingerprint/:id', () => {
  it('removes the enrolment', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await enrol(owner.gymId, member.id);

    const res = await api().delete(`/api/fingerprint/${member.id}`)
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(204);
    expect(await prisma.fingerprintTemplate.count()).toBe(0);
  });

  it('404s when the member has none', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    const res = await api().delete(`/api/fingerprint/${member.id}`)
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(404);
  });

  it('cannot reach another gym’s enrolment', async () => {
    const owner = await makeGym();
    const other = await makeGym({ gymName: 'Other Gym' });
    const theirMember = await addMember(other.gymId);
    await enrol(other.gymId, theirMember.id);

    const res = await api().delete(`/api/fingerprint/${theirMember.id}`)
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(404);
    expect(await prisma.fingerprintTemplate.count()).toBe(1);
  });
});

describe('deleting a member', () => {
  it('takes their fingerprint with them', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await enrol(owner.gymId, member.id);

    await prisma.member.delete({ where: { id: member.id } });

    // onDelete: Cascade. A biometric outliving the person it belongs to is the
    // kind of leftover nobody goes looking for.
    expect(await prisma.fingerprintTemplate.count()).toBe(0);
  });
});

describe('POST /api/fingerprint/identify', () => {
  it('resolves a member the device already matched', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId, { name: 'Ayesha Khan' });

    const res = await api().post('/api/fingerprint/identify')
      .set('Cookie', owner.cookie)
      .send({ externalId: member.id });

    expect(res.status).toBe(200);
    expect(res.body.matched).toBe(true);
    expect(res.body.member.name).toBe('Ayesha Khan');
  });

  it('reports no_match for an id this gym does not have', async () => {
    // A reader whose store has drifted from the database. "No match" is both
    // true and the only safe answer.
    const owner = await makeGym();
    const other = await makeGym({ gymName: 'Other Gym' });
    const theirMember = await addMember(other.gymId);

    const res = await api().post('/api/fingerprint/identify')
      .set('Cookie', owner.cookie)
      .send({ externalId: theirMember.id });

    expect(res.status).toBe(404);
    expect(res.body.matched).toBe(false);
    expect(res.body.reason).toBe('no_match');
  });

  it('rejects a request carrying neither an id nor a template', async () => {
    const owner = await makeGym();

    const res = await api().post('/api/fingerprint/identify')
      .set('Cookie', owner.cookie)
      .send({});

    expect(res.status).toBe(400);
  });

  it('says the reader is unavailable when asked to match without one', async () => {
    const owner = await makeGym();

    const res = await api().post('/api/fingerprint/identify')
      .set('Cookie', owner.cookie)
      .send({ template: Buffer.from('probe').toString('base64'), format: 'fake-v1' });

    expect(res.status).toBe(503);
    expect(res.body.configured).toBe(false);
  });

  it('writes no attendance of its own', async () => {
    // Identify answers "who is this" and stops. The check-in that follows is
    // the same endpoint the search tab and the QR scanner post to, so the
    // one-per-day rule cannot acquire a second implementation here.
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    await api().post('/api/fingerprint/identify')
      .set('Cookie', owner.cookie)
      .send({ externalId: member.id });

    expect(await prisma.attendance.count()).toBe(0);
  });

  it('is open to a receptionist', async () => {
    const owner = await makeGym();
    const desk = await addUser(owner.gymId, { staffPermission: 'receptionist' });
    const member = await addMember(owner.gymId);

    const res = await api().post('/api/fingerprint/identify')
      .set('Cookie', desk.cookie)
      .send({ externalId: member.id });

    expect(res.status).toBe(200);
  });
});

describe('POST /api/fingerprint/capture', () => {
  it('reports the reader unavailable when none is configured', async () => {
    const owner = await makeGym();

    const res = await api().post('/api/fingerprint/capture').set('Cookie', owner.cookie);

    expect(res.status).toBe(503);
    expect(res.body.configured).toBe(false);
  });

  it('is closed to a receptionist', async () => {
    // A reader that will scan for anyone who can work the desk is a reader
    // that can harvest templates.
    const owner = await makeGym();
    const desk = await addUser(owner.gymId, { staffPermission: 'receptionist' });

    const res = await api().post('/api/fingerprint/capture').set('Cookie', desk.cookie);

    expect(res.status).toBe(403);
  });
});
