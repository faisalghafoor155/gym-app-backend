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
