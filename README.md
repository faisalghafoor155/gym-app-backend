# GymPro backend

Express + Prisma (Postgres) API for GymPro. Split out of the `gym-app`
monorepo with its history, so it can be deployed on its own host.

## Run locally

```bash
cp .env.example .env      # set DATABASE_URL and a 32+ char JWT_SECRET
npm ci
npm run db:generate
npx prisma migrate deploy
npm run dev               # http://localhost:5000
```

## Deploy

```bash
npm ci
npm run db:generate
npm run build
npx prisma migrate deploy
npm start                 # node dist/index.js
```

Put the server in the same region as the database: every request makes
several queries, and each one pays the round trip between them.

The session cookie is `sameSite: lax`, so the frontend must reach this API on
its own origin. Point the frontend host's `/api/*` at this server with a
rewrite or proxy rather than calling it cross-origin.

`GET /api/health` answers without touching the database.
