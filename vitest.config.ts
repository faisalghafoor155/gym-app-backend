import 'dotenv/config';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.integration.test.ts'],
    environment: 'node',

    // Provisions a throwaway database and repoints DATABASE_URL at it before
    // any app module loads. Unit tests are unaffected — they import nothing
    // that connects.
    globalSetup: ['./src/test/setup.ts'],

    // One process for the whole suite. The integration tests truncate shared
    // tables between cases, so two files running at once would delete each
    // other's fixtures mid-request.
    fileParallelism: false,

    // Migrations on a cold database push the first file past the 5s default.
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
