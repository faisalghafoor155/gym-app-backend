/** @format */

import * as Sentry from "@sentry/node";
import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";

/**
 * Error reporting and request logging.
 *
 * Until this existed, every failure in the app was a `console.error` into the
 * container's stdout. That is invisible in practice: nobody is tailing
 * `docker compose logs` at the moment a member's payment 500s, and by the time
 * anyone looks the line has scrolled away or the container has been recycled.
 * A gym owner's first report of a bug was the bug's first report, too.
 *
 * Two pieces, deliberately independent:
 *
 *   * **Structured request logs**, always on. One line per request, as JSON,
 *     carrying a request id. They go to stdout like everything else, but they
 *     can be grepped, shipped and correlated, which prose cannot.
 *   * **Sentry**, only when SENTRY_DSN is set. It is what turns an error into
 *     something that arrives — with a stack, the request that caused it, and
 *     the release it happened on — rather than something to be discovered.
 *
 * Sentry is optional on purpose. A gym running this on one machine should not
 * need an account with anyone to start the app, and self-hosting is a
 * reasonable choice. With no DSN the SDK is never initialised, every capture is
 * a no-op, and the structured logs carry on alone.
 */

/** Whether error reporting is switched on. */
export const isSentryEnabled = (): boolean => Boolean(process.env.SENTRY_DSN);

/**
 * Starts Sentry, if it is configured.
 *
 * Must run before the Express app is built, so the SDK's instrumentation is in
 * place before any route or middleware is registered.
 */
export const initObservability = (): void => {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log(
      "[observability] SENTRY_DSN is not set — errors are logged to stdout " +
        "only. Nothing will alert you when the app fails in production.",
    );
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
    // Lets a stack trace point at the deploy it came from. Unset is fine; it
    // just means every issue looks like it happened on the same version.
    release: process.env.SENTRY_RELEASE,

    // Performance tracing is off by default. It is billed per transaction and
    // a gym's API is not where a latency problem will hide — the value here is
    // errors. Set SENTRY_TRACES_SAMPLE_RATE=0.1 to sample it later.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),

    // This app handles member names, phone numbers, addresses and payment
    // records. `sendDefaultPii` would attach request bodies, headers and IPs to
    // every event and ship a gym's member data to a third party as a side
    // effect of an error. Off, and the scrubbing below assumes it stays off.
    sendDefaultPii: false,

    beforeSend(event) {
      // Belt and braces over sendDefaultPii. A cookie header carries the
      // session JWT — anyone reading the issue could sign in as the user it
      // belonged to — and a body can carry a password or a member's details.
      if (event.request) {
        delete event.request.cookies;
        delete event.request.data;
        if (event.request.headers) {
          for (const h of ["cookie", "authorization", "x-api-key"]) {
            delete event.request.headers[h];
          }
        }
      }
      return event;
    },
  });

  console.log(
    `[observability] Sentry enabled (${process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development"})`,
  );
};

/** A JSON line on stdout. One shape for everything, so logs can be parsed. */
const emit = (
  level: "info" | "warn" | "error",
  message: string,
  fields: Record<string, unknown> = {},
): void => {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

export const log = {
  info: (message: string, fields?: Record<string, unknown>) =>
    emit("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) =>
    emit("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) =>
    emit("error", message, fields),
};

declare module "express-serve-static-core" {
  interface Request {
    /** Correlates a log line, an error report and a support email. */
    requestId?: string;
  }
}

/**
 * Tags every request with an id and logs how it finished.
 *
 * The id goes out on the response as `X-Request-Id`, so a member who reports
 * "it failed at 4pm" can be matched to the exact line — which is the difference
 * between a five-minute fix and an afternoon of guessing.
 *
 * Logged on `finish` rather than up front: a line written before the work
 * happens cannot carry the status or the duration, which are the two fields
 * anyone actually reads.
 */
export const requestLogger = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const id = randomUUID();
  req.requestId = id;
  res.setHeader("X-Request-Id", id);

  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;

    // The health check runs every ten seconds against every container. Logging
    // it would bury the traffic that matters in a line nobody will ever read.
    if (req.originalUrl === "/api/health" && res.statusCode === 200) return;

    // The path only — never `req.originalUrl` with its query string, which
    // carries reset tokens and search terms into a log that is shipped and
    // kept.
    emit(res.statusCode >= 500 ? "error" : "info", "request", {
      requestId: id,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Math.round(ms),
    });
  });

  next();
};

/**
 * Reports an error, attaching the request that caused it.
 *
 * Used by the app's own error handler rather than Sentry's Express middleware,
 * so the response body stays exactly what it was — the handler already decides
 * what a client is told, and that is a product decision, not a reporting one.
 */
export const captureError = (
  err: unknown,
  req?: Request,
  context?: Record<string, unknown>,
): void => {
  const requestId = req?.requestId;

  log.error("unhandled error", {
    requestId,
    method: req?.method,
    path: req?.path,
    err: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    ...context,
  });

  if (!isSentryEnabled()) return;

  Sentry.withScope((scope) => {
    if (requestId) scope.setTag("request_id", requestId);
    if (req) {
      scope.setTag("method", req.method);
      scope.setTag("path", req.path);
      // The signed-in account, not the member's details: enough to see whether
      // one gym is affected or all of them, without shipping anyone's roster.
      const authed = req as Request & { userId?: string; gymId?: string };
      if (authed.userId) scope.setUser({ id: authed.userId });
      if (authed.gymId) scope.setTag("gym_id", authed.gymId);
    }
    if (context) scope.setContext("details", context);
    Sentry.captureException(err);
  });
};

/**
 * Flushes buffered events before the process exits.
 *
 * Sentry batches, so a crash that takes the process down would otherwise lose
 * the very error that explains it.
 */
export const flushObservability = async (timeoutMs = 2000): Promise<void> => {
  if (!isSentryEnabled()) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // Losing an error report must never be what stops a shutdown.
  }
};
