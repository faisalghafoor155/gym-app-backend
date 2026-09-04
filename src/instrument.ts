/** @format */

/**
 * Starts error reporting, and nothing else.
 *
 * This file exists only so that `initObservability()` runs before the rest of
 * the application is loaded. ES module imports are hoisted and evaluated ahead
 * of every statement in the importing file, so a call placed at the top of
 * `index.ts` would still happen after Express, Prisma and every route had
 * already been pulled in. Sentry patches modules as they load, so anything
 * imported before it starts is left uninstrumented.
 *
 * A side-effecting import of this module is the one thing that reliably goes
 * first. Keep `import "./instrument.js"` as the first import in index.ts.
 */

import { initObservability } from "./services/observability.js";

initObservability();
