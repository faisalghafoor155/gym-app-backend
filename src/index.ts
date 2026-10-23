/** @format */

import "dotenv/config";

// First, and as a side-effecting import rather than a call: ES module imports
// are all hoisted and evaluated before any statement in this file runs, so a
// `initObservability()` written here would execute *after* every import below
// no matter how high up the page it sat. Sentry instruments modules as they
// load, so it has to win that race — which means starting inside a module that
// is itself imported first.
import "./instrument.js";

import express, { type ErrorRequestHandler } from "express";
import path from "node:path";
import fs from "node:fs";
import {
  requestLogger,
  captureError,
  flushObservability,
} from "./services/observability.js";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";

import authRoutes from "./routes/auth.js";
import twoFactorRoutes from "./routes/twoFactor.js";
import usersRoutes from "./routes/users.js";
import meRoutes from "./routes/me.js";
import dashboardRoutes from "./routes/dashboard.js";
import membersRoutes from "./routes/members.js";
import membershipPlansRoutes from "./routes/membershipPlans.js";
import auditLogsRoutes from "./routes/auditLogs.js";
import attendanceRoutes from "./routes/attendance.js";
import fingerprintRoutes from "./routes/fingerprint.js";
import paymentsRoutes from "./routes/payments.js";
import plansRoutes from "./routes/plans.js";
import supplementsRoutes from "./routes/supplements.js";
import trainersRoutes from "./routes/trainers.js";
import ptSessionsRoutes from "./routes/ptSessions.js";
import classesRoutes from "./routes/classes.js";
import classBookingsRoutes from "./routes/classBookings.js";
import onlinePaymentsRoutes from "./routes/onlinePayments.js";
import gymSettingsRoutes from "./routes/gymSettings.js";
import expensesRoutes from "./routes/expenses.js";
import analyticsRoutes from "./routes/analytics.js";
import payoutsRoutes from "./routes/payouts.js";
import subscriptionRoutes from "./routes/subscription.js";
import billingRoutes from "./routes/billing.js";
import aiRoutes from "./routes/ai.js";
import promoCodesRoutes from "./routes/promoCodes.js";
import referralsRoutes from "./routes/referrals.js";
import lockersRoutes from "./routes/lockers.js";
import { hasLiveGateway } from "./services/gateways/index.js";
import { hasPlatformGateway } from "./services/gateways/platform.js";
import { biometricKeyStatus } from "./services/fingerprint/crypto.js";
import { mailEnabled } from "./services/mail.js";
import { startJobs } from "./jobs/index.js";

// Fail loudly at boot rather than turning every login into a generic 500.
//
// On Vercel an exit at import becomes FUNCTION_INVOCATION_FAILED, which says
// nothing to whoever is reading the browser — and the logs that would say it
// are not always to hand. There the problems are kept instead, and every API
// request answers 503 with them (names and reasons, never values) until the
// configuration is fixed and the project redeployed.
const startupProblems: string[] = [];
const fatal = (message: string): void => {
  console.error(message);
  if (!process.env.VERCEL) process.exit(1);
  startupProblems.push(message);
};

for (const key of ["JWT_SECRET", "DATABASE_URL"] as const) {
  if (!process.env[key]) {
    fatal(`Missing required environment variable: ${key}`);
  }
}
if ((process.env.JWT_SECRET ?? "").length < 32) {
  fatal("JWT_SECRET must be at least 32 characters");
}

// Biometric templates are encrypted with this, and a missing key must stop the
// server rather than be discovered at the first enrolment. Checked even when no
// reader is configured: a gym that buys one should find out on the deploy that
// preceded it, not at the desk with a member's finger on the glass.
const biometricKey = biometricKeyStatus();
if (!biometricKey.ok) {
  fatal(biometricKey.error);
}

// Settings that are right for localhost and wrong the moment a member can
// reach the app. Each is legitimate in development, so none of them can fail
// the boot — but in production every one is a way to lose data or a session,
// and the failure is silent. Said once, loudly, where a deploy will show it.
//
// Warnings rather than exits on purpose: an operator mid-migration should not
// find the app refusing to start over a setting that was fine yesterday.
if (process.env.NODE_ENV === "production") {
  const unsafe: string[] = [];

  // The session cookie is only marked Secure when this is on. Without it the
  // cookie rides over plain http and one downgraded request hands a 30-day
  // session to anyone on the same network.
  if (process.env.HTTPS === "false") {
    unsafe.push(
      "HTTPS=false — session cookies are NOT marked Secure and password-reset " +
        "links are plain http. Use docker-compose.https.yml, or set HTTPS=true " +
        "if TLS is terminated by a proxy in front of this app.",
    );
  }

  // A reset link built from an http:// or localhost URL either does not work
  // or works over a channel that leaks the token in it.
  const appUrl = process.env.APP_URL ?? "";
  if (appUrl.startsWith("http://") && !appUrl.includes("localhost")) {
    unsafe.push(
      `APP_URL is plain http (${appUrl}) — password-reset and invite links ` +
        "carry a token that anyone on the path can read and use.",
    );
  }

  // HTTPS=true only *marks* the cookie Secure; it does not provide TLS. A
  // deployment can therefore look correct here while its certificate belongs
  // to a tunnel that dies on restart. APP_URL is the tell: reset and invite
  // links are built from it and outlive the session that requested them, so a
  // temporary hostname means links that 404 by the time somebody clicks them.
  const ephemeralHosts = [
    "trycloudflare.com",
    "ngrok.io",
    "ngrok-free.app",
    "loca.lt",
    "serveo.net",
  ];
  const host = appUrl.replace(/^https?:\/\//, "").split("/")[0];
  const ephemeral = ephemeralHosts.find((h) => host.endsWith(h));
  if (ephemeral) {
    unsafe.push(
      `APP_URL points at a temporary tunnel (${host}) — the hostname changes ` +
        "when the tunnel restarts, and every password-reset and invite link " +
        "already sent stops resolving. Point it at the permanent domain.",
    );
  }

  // Behind a proxy every request carries the proxy's IP, so with no hops
  // configured the rate limiter buckets the whole world together: one attacker
  // exhausts the login budget for every gym at once. Deliberately not
  // defaulted — the right number is the count of proxies actually in front of
  // this process, and guessing it wrong is how X-Forwarded-For gets spoofed.
  if (!process.env.TRUST_PROXY_HOPS) {
    unsafe.push(
      "TRUST_PROXY_HOPS is not set — rate limits count every request as " +
        "coming from the proxy, so one attacker can lock out every user. Set " +
        "it to the number of proxies in front of this app (1 for the Docker " +
        "nginx alone; 2 with a CDN or tunnel in front of that).",
    );
  }

  // The one that strands people. `sendMail` never throws and the
  // forgot-password endpoint answers identically either way — both deliberate,
  // and together they make a dead transport invisible from outside. A staff
  // member who forgets their password has no way back in, and an owner's
  // invite is never delivered, with nothing anywhere saying why.
  if (!mailEnabled) {
    unsafe.push(
      "Mail is NOT configured — password resets and staff invites are written " +
        "to this log instead of being delivered, and nothing tells the person " +
        "waiting for them. Set RESEND_API_KEY, or the SMTP_* variables.",
    );
  }

  // Not fatal — the app runs fine and refuses photos with a clear message —
  // but it is the kind of thing found by a receptionist rather than a deploy.
  if (!process.env.S3_BUCKET_NAME) {
    unsafe.push(
      "S3 is not configured — member photo uploads will be REFUSED. Set " +
        "AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and S3_BUCKET_NAME.",
    );
  }

  if (unsafe.length) {
    console.warn(
      "\n[startup] This deployment has unsafe settings for production:\n" +
        unsafe.map((w) => `  * ${w}`).join("\n") +
        "\n",
    );
  }
}

// Said once at boot rather than left for an operator to infer from a member
// complaining that renewals never complete. Without a configured gateway the
// portal still works — it files front-desk requests instead of taking cards.
if (!hasLiveGateway()) {
  console.warn(
    "[online-payments] no payment gateway configured; online renewals will be " +
      "recorded as front-desk requests for staff to confirm. Set JAZZCASH_* or " +
      "EASYPAISA_* to take payments online.",
  );
}

// The other half of the same point, for the other direction the money moves.
// Without this a gym can be invoiced and suspended for not paying, with no way
// to pay from inside the app — which is worse than not billing at all.
if (!hasPlatformGateway()) {
  console.warn(
    "[billing] no platform payment gateway configured; gyms cannot settle " +
      "subscription invoices online and must be marked paid by an operator. " +
      "Set PLATFORM_JAZZCASH_* or PLATFORM_EASYPAISA_* to collect them.",
  );
}

const app = express();

// Behind the nginx container exactly one proxy sits in front of us. Without
// this, every request looks like it comes from the proxy's IP and one attacker
// could rate-limit every gym out of the app. `true` is avoided deliberately:
// it would let a client spoof its IP via X-Forwarded-For.
// In tests, one hop so a forged X-Forwarded-For reaches the limiter — the
// rate-limit cases need distinct client IPs to get independent budgets.
app.set(
  "trust proxy",
  Number(
    process.env.TRUST_PROXY_HOPS ?? (process.env.NODE_ENV === "test" ? 1 : 0),
  ),
);

// Before the routes and before the body parser, so a request that is rejected
// for being oversized is still logged and still carries an id to quote.
app.use(requestLogger);

if (startupProblems.length) {
  app.use("/api", (_req, res) => {
    res.status(503).json({
      error: "Server is misconfigured",
      problems: startupProblems,
    });
  });
}

// Helmet's default CSP carries `upgrade-insecure-requests`, and it sends HSTS.
// Both assume TLS. On a deployment that is honestly plain http — the desktop
// app reached from a phone on the gym's Wi-Fi (http://192.168.x.x:5000), or
// Docker without the https overlay — a phone obeys the CSP, rewrites every
// script and stylesheet to https://, fails to load them, and shows a blank
// page. Desktop never sees it because browsers exempt localhost. HTTPS=false
// is the explicit statement that there is no TLS, so only then are they off
// (and in development, which never has TLS either).
const plainHttp =
  process.env.HTTPS === "false" || process.env.NODE_ENV !== "production";
app.use(
  helmet(
    plainHttp
      ? {
          contentSecurityPolicy: {
            directives: { upgradeInsecureRequests: null },
          },
          hsts: false,
        }
      : undefined,
  ),
);

// In production only the configured origins may call the API. CORS_ORIGIN is a
// comma-separated list; when the frontend is served by the same nginx as the
// API (the Docker setup) requests are same-origin and none is needed.
const allowedOrigins = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors(
    process.env.NODE_ENV === "production"
      ? {
          origin: allowedOrigins.length ? allowedOrigins : false,
          credentials: true,
        }
      : // Dev reflects the caller's origin rather than sending `*`: a wildcard is
        // rejected by browsers on credentialed requests, which the session cookie
        // now makes every request.
        { origin: true, credentials: true },
  ),
);

// Member photos are sent as base64 data-URLs inside JSON. The client caps the
// file at 2MB and base64 adds ~33%, so the default 100kb limit rejects them.
app.use(express.json({ limit: "4mb" }));
app.use(cookieParser());

// Credential stuffing guard. Only failed attempts count, so a busy gym logging
// in legitimately is never locked out.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again in 15 minutes." },
  // Every integration test shares one IP, so a suite of failed-login cases
  // would trip the limiter and start testing it instead of the endpoint. The
  // opt-out is per-request rather than a disabled limiter, so the middleware
  // under test is still the real one — see auth.integration.test.ts, which
  // clears this header to assert the throttling actually works.
  skip: (req) =>
    process.env.NODE_ENV === "test" &&
    req.headers["x-test-skip-ratelimit"] === "1",
});

app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);
app.use("/api/auth/forgot-password", authLimiter);
app.use("/api/auth/reset-password", authLimiter);
// Invite tokens are credentials too — guessing one must cost the same as
// guessing a password.
app.use("/api/auth/invite", authLimiter);
app.use("/api/auth/accept-invite", authLimiter);
// The 2FA challenge proves the password already, so each attempt here is a
// guess at the second factor — it must cost the same as guessing a password.
app.use("/api/auth/two-factor/verify-login", authLimiter);
// Regenerating backup codes takes the account password, and the reward for
// guessing it is a set of credentials that bypass the second factor. That is
// a password-guessing endpoint whatever else it is, so it is throttled as one.
app.use("/api/auth/two-factor/backup-codes", authLimiter);
// Turning 2FA off asks for the password, so a stolen session cookie can guess
// it here. Only DELETE: status and setup are ordinary authenticated reads.
app.use("/api/auth/two-factor", (req, res, next) =>
  req.method === "DELETE" ? authLimiter(req, res, next) : next(),
);

// Starting a checkout writes a row and calls out to a provider. Unthrottled,
// one member holding the button down fills the intents table; a stranger
// hammering the callback path gets unlimited free guesses at a signature.
// Successful attempts count here, unlike the auth limiter — a member does not
// legitimately start twenty payments in a quarter of an hour.
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many payment attempts. Please try again shortly." },
  skip: (req) =>
    process.env.NODE_ENV === "test" &&
    req.headers["x-test-skip-ratelimit"] === "1",
});

app.use("/api/online-payments/checkout", paymentLimiter);
app.use("/api/online-payments/callback", paymentLimiter);
// Same reasoning for the gym paying us: an unthrottled callback path is
// unlimited free guesses at a signature, and an unthrottled checkout lets one
// owner hold the button down.
app.use("/api/billing/checkout", paymentLimiter);
app.use("/api/billing/callback", paymentLimiter);

app.use("/api/auth", authRoutes);
app.use("/api/auth/two-factor", twoFactorRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/me", meRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/members", membersRoutes);
app.use("/api/membership-plans", membershipPlansRoutes);
app.use("/api/audit-logs", auditLogsRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/fingerprint", fingerprintRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api/plans", plansRoutes);
app.use("/api/supplements", supplementsRoutes);
app.use("/api/trainers", trainersRoutes);
app.use("/api/pt-sessions", ptSessionsRoutes);
app.use("/api/classes", classesRoutes);
app.use("/api/class-bookings", classBookingsRoutes);
app.use("/api/online-payments", onlinePaymentsRoutes);
app.use("/api/gym-settings", gymSettingsRoutes);
app.use("/api/expenses", expensesRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/payouts", payoutsRoutes);
app.use("/api/subscription", subscriptionRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/promo-codes", promoCodesRoutes);
app.use("/api/referrals", referralsRoutes);
app.use("/api/lockers", lockersRoutes);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Single-origin deployments (Render, and anywhere else without a separate
// nginx) serve the built frontend from this process. Set SERVE_STATIC_DIR to
// the Vite dist folder to switch it on; the Docker image leaves it unset
// because nginx serves the bundle there.
//
// Same-origin is the point, not a convenience: the session cookie is
// sameSite 'lax', so a frontend on a different host than the API would never
// have it sent and every request would arrive logged out.
let staticDir = process.env.SERVE_STATIC_DIR;
if (!staticDir) {
  const candidates = [
    path.resolve("../frontend/dist"),
    path.resolve("./frontend/dist"),
    path.resolve("dist-frontend"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "index.html"))) {
      staticDir = c;
      break;
    }
  }
}

if (staticDir && fs.existsSync(staticDir)) {
  const root = path.resolve(staticDir);

  // Hashed Vite assets are immutable; everything else (index.html above all)
  // must revalidate or a deploy would not reach anyone still holding a tab.
  app.use(
    "/assets",
    express.static(path.join(root, "assets"), {
      immutable: true,
      maxAge: "1y",
    }),
  );
  app.use(express.static(root, { index: false }));

  // SPA fallback for react-router deep links. The /api exclusion is what keeps
  // an unknown API path a 404: without it every mistyped endpoint would answer
  // 200 with index.html, which reaches the client as a parse error rather than
  // as a miss.
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(root, "index.html"));
  });
}

// Oversized or malformed JSON bodies reject before any route runs, so they
// need handling here rather than in a controller.
const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  const type = (err as { type?: string }).type;
  if (type === "entity.too.large") {
    res
      .status(413)
      .json({ error: "Photo is too large. Please use an image under 2MB." });
    return;
  }
  if (type === "entity.parse.failed") {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  // Anything reaching here is a fault in the app rather than in the request,
  // which is exactly the class of thing nobody finds out about on their own.
  // The two rejections above are deliberately not reported: a client sending a
  // 5MB photo or malformed JSON is not a bug worth waking anyone for.
  captureError(err, req);
  res.status(500).json({ error: "Server error" });
};
app.use(errorHandler);

/**
 * Exported so tests can mount the real app — every route, middleware and the
 * error handler above — against supertest without opening a port.
 */
export default app;

// Started only when run as the server. Importing this module (as the tests do)
// must not bind a port, or a second import would fight the first for it. The
// same applies to the scheduler: a background job firing mid-suite would write
// rows no test asked for.
//
// Vercel is the other importer: it mounts the default export as a function and
// owns the port itself. Its instances are frozen between requests, so node-cron
// would fire at random or not at all, and process.exit would kill an instance
// still serving other requests — none of this block belongs there.
if (process.env.NODE_ENV !== "test" && !process.env.VERCEL) {
  const PORT = Number(process.env.PORT ?? 5000);
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
  startJobs();

  // The failures that matter most are the ones that take the process with
  // them: a rejected promise in a scheduled job, a throw outside any request.
  // Docker restarts the container and the reason disappears with the old one,
  // so it has to be reported — and flushed — before the exit completes.
  process.on("unhandledRejection", (reason) => {
    captureError(reason instanceof Error ? reason : new Error(String(reason)));
  });

  process.on("uncaughtException", (err) => {
    captureError(err);
    // Sentry batches, so exiting immediately would drop the very error that
    // explains the crash. An uncaught exception leaves the process in an
    // undefined state, so it still exits — just not before the report is away.
    void flushObservability().finally(() => process.exit(1));
  });

  // Compose stops containers with SIGTERM. Anything still buffered is lost
  // unless it is flushed here.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void flushObservability().finally(() => process.exit(0));
    });
  }
}
