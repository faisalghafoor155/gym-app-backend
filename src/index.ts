/** @format */

import "dotenv/config";
import express, { type ErrorRequestHandler } from "express";
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
import paymentsRoutes from "./routes/payments.js";
import plansRoutes from "./routes/plans.js";
import supplementsRoutes from "./routes/supplements.js";
import trainersRoutes from "./routes/trainers.js";
import ptSessionsRoutes from "./routes/ptSessions.js";
import classesRoutes from "./routes/classes.js";
import classBookingsRoutes from "./routes/classBookings.js";
import onlinePaymentsRoutes from "./routes/onlinePayments.js";
import { startJobs } from "./jobs/index.js";

// Fail loudly at boot rather than turning every login into a generic 500.
for (const key of ["JWT_SECRET", "DATABASE_URL"] as const) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}
if (process.env.JWT_SECRET!.length < 32) {
  console.error("JWT_SECRET must be at least 32 characters");
  process.exit(1);
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

app.use(helmet());

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

app.use("/api/auth", authRoutes);
app.use("/api/auth/two-factor", twoFactorRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/me", meRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/members", membersRoutes);
app.use("/api/membership-plans", membershipPlansRoutes);
app.use("/api/audit-logs", auditLogsRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api/plans", plansRoutes);
app.use("/api/supplements", supplementsRoutes);
app.use("/api/trainers", trainersRoutes);
app.use("/api/pt-sessions", ptSessionsRoutes);
app.use("/api/classes", classesRoutes);
app.use("/api/class-bookings", classBookingsRoutes);
app.use("/api/online-payments", onlinePaymentsRoutes);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Oversized or malformed JSON bodies reject before any route runs, so they
// need handling here rather than in a controller.
const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
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
  console.error(err);
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
if (process.env.NODE_ENV !== "test") {
  const PORT = Number(process.env.PORT ?? 5000);
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
  startJobs();
}
