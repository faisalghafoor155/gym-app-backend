# Fingerprint readers

Everything above this folder — the endpoints, the Attendance tab, the enrolment
UI — is finished and does not know what reader is plugged in. Wiring a real one
up means adding a file here and listing it in `index.ts`. Nothing else.

## What to buy

Two shapes of hardware exist, and the choice matters more than the brand.

**Standalone network readers** (ZKTeco and most of what is on the shelf in
Pakistan, roughly 15–30k PKR) hold their own template store, match internally
and answer over TCP or HTTP. The backend talks to them directly. Set
`matchesLocally: true` and implement `identify`; `match` can throw.

**Bare USB scanners** hand over a template and nothing else. A browser cannot
read one — WebUSB does not reach fingerprint class devices, and no amount of
frontend work changes that — so a USB scanner needs a small service running on
the front-desk PC that owns the USB handle and speaks HTTP to this backend.
That is a second thing to install, update and keep running on a machine nobody
administers. Set `matchesLocally: false`, implement `capture` and `match`, and
budget for the bridge.

Prefer the first unless there is a reason not to.

## Writing the adapter

```ts
// src/services/fingerprint/zkteco.ts
import type { FingerprintDevice } from './types.js';

export const zkteco: FingerprintDevice = {
  id: 'zkteco',
  label: 'ZKTeco reader',
  format: 'zkteco-v10',      // goes in FingerprintTemplate.format
  matchesLocally: true,
  isConfigured: () => Boolean(process.env['ZKTECO_HOST']),
  isOnline: async () => { /* ping it */ },
  identify: async () => { /* ask who is at the reader */ },
  capture: async () => { /* read a finger, for enrolment */ },
  match: async () => { throw new Error('device matches internally'); },
  enroll: async (memberId, template) => { /* push to device store */ },
  forget: async (memberId) => { /* remove from device store */ },
};
```

Then add it to `ALL` in `index.ts` and set its env vars. `activeDevice()` picks
the first configured entry.

`tests/services/fingerprint.test.ts` exercises both shapes against fakes. Point
those tests at a new adapter to check it before the hardware is on site.

## Things worth knowing before you start

**Templates are not portable.** A ZKTeco template means nothing to a Suprema
reader. This is why `format` is stored per row: swapping vendors invalidates
every enrolment, and the code refuses to match across formats rather than
silently failing to recognise anybody. Plan a re-enrolment day, and keep the
old reader until it is done.

**The database copy is the backup, not the source.** On a `matchesLocally`
device the reader is authoritative during check-in; the row exists so a
replacement unit can be re-provisioned without dragging 150 members back to
the desk. Keep `enroll`/`forget` honest so the two stores do not drift.

**Some fingers never enrol.** Manual labour, age, and skin conditions all
defeat readers, and the rate is not negligible — plan on a few percent of any
gym's members. The manual search tab is the fallback and must stay usable; a
check-in flow that can only be completed with a finger will strand those
members at the desk.

**This is biometric data.** Only the vendor's irreversible template is stored,
never an image, and `FingerprintTemplate` rows are deleted with the member
(`onDelete: Cascade`). Tell members what is being taken and why before taking
it, and let anyone decline and use the QR code instead.

## Encryption at rest

Templates are encrypted with AES-256-GCM before they reach the database and
decrypted on the way out. `crypto.ts` holds the whole of it; `fingerprintController`
is the only caller, so plaintext exists there and nowhere else on the server.

`BIOMETRIC_KEY` is required — the server will not boot without it, reader or no
reader. Generate one with `openssl rand -base64 32` and keep it in a secret
manager or the deployment environment.

Three things worth being clear about:

- **The key must not live with the data.** Disk encryption already covers a
  stolen server. What it does not cover is a `pg_dump` on somebody's laptop, a
  read replica, or a leaked `DATABASE_URL` — in all of those the database hands
  the bytes over willingly. That is the threat this addresses, and it only holds
  if the key is somewhere the database is not, including in backups.
- **Losing the key loses every enrolment.** There is no recovery path. Every
  member has to be enrolled again at the desk.
- **Each row is bound to its member.** The member id is GCM additional
  authenticated data, so a template moved to another member's row fails to
  decrypt rather than opening the door for the wrong person.

Rotation, without a flag day: put the new key first and keep the old one, so
rows written under either still open.

```
BIOMETRIC_KEY="2:<new base64>,1:<old base64>"
```

Re-enrolling a member re-encrypts under the primary key. There is no bulk
re-encryption job yet — until there is, keep the old key listed.

## Retention

Templates are not kept for as long as the gym runs. `jobs/fingerprintRetention.ts`
deletes the enrolment of anyone who has stopped coming, daily at 03:00.

A member qualifies once they have had no active membership for
`LAPSED_AFTER_DAYS` (60, from `services/membership.ts`) plus
`FINGERPRINT_RETENTION_GRACE_DAYS` (default 90) — about five months. Built on
the existing lapsed rule rather than a threshold of its own, so there is one
definition of a departed member rather than two that drift apart.

Three groups are covered: members whose membership expired that long ago,
members deactivated by hand, and members who never bought anything, measured
from the enrolment date instead. A hand deactivation deletes even when the dates
still look live — staff marking somebody inactive is an explicit decision, and
it outranks the calendar the same way `effectiveMemberStatus` treats it.

What it deliberately does **not** do:

- **It deletes only the template.** The member, their attendance, their payments
  and their member number stay. Biometric data earns a shorter life than the
  gym's own commercial record of the same person; when to delete the rest is a
  different question.
- **It cannot be switched off through configuration.** "Keep biometrics for
  ever" is not a setting worth making easy. A gym that wants it has to stop
  running scheduled work at all (`RUN_JOBS=false`).

A member who comes back simply enrols again — a minute at the desk, against a
template otherwise kept indefinitely for somebody who left. Each deletion writes
a `fingerprint.retention` audit row naming the member, so the trail answers
"where did this go" without ever copying the template into it.

To see what the policy would do without waiting for 03:00:

```sh
npm run retention:fingerprints              # list what would be deleted
npm run retention:fingerprints -- --delete  # actually delete
```

Previewing is the default and deleting takes a flag, because a deletion here
cannot be undone — every affected member would have to be re-enrolled in person.
The preview calls `findExpiredEnrolments`, the same helper the job uses, so what
it lists is what a real run would take.
