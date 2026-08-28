import { execFileSync } from 'node:child_process';
import { Client } from 'pg';

/**
 * Creates a throwaway database for the integration suite and points the app at
 * it, before any application module is imported.
 *
 * This runs as a vitest `globalSetup`, so it happens once per run rather than
 * per file, and — crucially — before `src/db.ts` reads DATABASE_URL to build
 * its connection pool.
 *
 * A separate database, never the development one: these tests truncate every
 * table between cases, which would wipe real gym data if pointed at `gymapp`.
 * The name is fixed rather than random so a crashed run leaves one stray
 * database to reuse, not a new one each time.
 */

const TEST_DB = 'gymapp_test';

/** Swaps the database name on the configured URL, keeping host and credentials. */
const withDatabase = (url: string, database: string): string => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};

const adminUrl = (url: string): string => withDatabase(url, 'postgres');

export default async function setup(): Promise<void> {
  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      'DATABASE_URL is not set. Integration tests need a reachable Postgres — ' +
      'copy backend/.env.example to backend/.env and fill it in.',
    );
  }

  const testUrl = withDatabase(base, TEST_DB);

  // Dropped and recreated so a run always starts from a known-empty schema,
  // even if a previous run died before its teardown.
  const admin = new Client({ connectionString: adminUrl(base) });
  await admin.connect();
  try {
    // FORCE disconnects any session left over from a killed run, which would
    // otherwise make the DROP hang.
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }

  // `migrate deploy` rather than `db push`: it applies the real migration
  // files, so the tests run against the schema production actually gets.
  // The local binary rather than `npx`, and without shell:true — passing args
  // through a shell is a quoting hazard. Windows cannot spawn the .cmd
  // shim directly, so there it goes through cmd.exe with fixed arguments.
  const [cmd, cmdArgs] = process.platform === 'win32'
    ? ['cmd.exe', ['/c', 'node_modules\\.bin\\prisma.cmd', 'migrate', 'deploy']]
    : ['node_modules/.bin/prisma', ['migrate', 'deploy']];

  execFileSync(cmd, cmdArgs, {
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'pipe',
  });

  // Handed to the test processes; `db.ts` picks it up when first imported.
  process.env.DATABASE_URL = testUrl;
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-characters-long!!';
  // A fixed 32-byte key so the suite can enrol and read back templates. Every
  // run starts from an empty database, so nothing is ever encrypted under one
  // run's key and read under another's.
  process.env.BIOMETRIC_KEY ??= Buffer.alloc(32, 7).toString('base64');
}
