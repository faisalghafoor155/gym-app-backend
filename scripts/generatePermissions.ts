/** @format */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  PERMISSION_DESCRIPTIONS,
  PERMISSION_LABELS,
  STAFF_PERMISSIONS,
  type PermissionRequirements,
} from '../src/services/permissions.js';

/**
 * Writes the client's copy of the permission table from the server's.
 *
 * The two used to be hand-maintained twins: 150 near-identical lines that had
 * to be edited together and had already started to drift. Generating the
 * client copy makes that impossible — the server table is the only one anybody
 * edits, and `tests/services/permissions.test.ts` fails the build if the
 * committed output no longer matches.
 *
 * Run with `npm run gen:permissions`.
 */

const HEADER = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Written from backend/src/services/permissions.ts by
 * backend/scripts/generatePermissions.ts. Change the table there and run
 * \`npm run gen:permissions\` in backend/, then commit both files.
 *
 * Editing this by hand is how the two copies drifted apart before; the
 * backend test suite fails if it stops matching its source.
 */`;

const sortedEntries = <T extends object>(obj: T): [string, unknown][] =>
  Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));

/** Serialises one level's flags, sorted so the output is stable across runs. */
const renderPermissions = (perms: PermissionRequirements): string =>
  sortedEntries(perms)
    .map(([key, value]) => `    ${key}: ${String(value)},`)
    .join('\n');

const renderRecord = (record: Record<string, string>): string =>
  sortedEntries(record)
    .map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`)
    .join('\n');

const interfaceFields = sortedEntries(
  Object.values(STAFF_PERMISSIONS)[0] as PermissionRequirements,
)
  .map(([key]) => `  ${key}: boolean;`)
  .join('\n');

const levels = sortedEntries(STAFF_PERMISSIONS)
  .map(
    ([level, perms]) =>
      `  ${level}: {\n${renderPermissions(perms as PermissionRequirements)}\n  },`,
  )
  .join('\n');

export const render = (): string => `${HEADER}

import type { StaffPermission } from '../types';

export interface PermissionRequirements {
${interfaceFields}
}

export const STAFF_PERMISSIONS: Record<StaffPermission, PermissionRequirements> = {
${levels}
};

export const PERMISSION_LABELS: Record<StaffPermission, string> = {
${renderRecord(PERMISSION_LABELS)}
};

export const PERMISSION_DESCRIPTIONS: Record<StaffPermission, string> = {
${renderRecord(PERMISSION_DESCRIPTIONS)}
};
`;

const OUTPUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../frontend/src/utils/permissions.generated.ts',
);

// Only writes when run directly, so the test can import `render` and compare
// without rewriting the file it is checking.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  writeFileSync(OUTPUT, render(), 'utf8');
  console.log(`Wrote ${OUTPUT}`);
}

export { OUTPUT };
