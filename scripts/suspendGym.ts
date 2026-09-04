/**
 * Stops a gym from using the app, and lets it back in.
 *
 * The lever for a gym that has stopped paying, or that has to be cut off for
 * any other reason. Run by whoever handles the billing:
 *
 *   npx tsx scripts/suspendGym.ts                        # list every gym and its state
 *   npx tsx scripts/suspendGym.ts <gymId> suspend        # stop it, with the default message
 *   npx tsx scripts/suspendGym.ts <gymId> suspend "Unpaid since March"
 *   npx tsx scripts/suspendGym.ts <gymId> resume         # let it back in
 *
 * ## Why this is not the plan
 *
 * Moving a gym to `free` is the wrong tool for non-payment. It does not stop
 * anybody — it shrinks them. A gym with 400 members dropped to `free` keeps
 * every one of them on screen, keeps taking attendance, and simply fails at
 * the front desk the next time somebody joins, with a limit message that reads
 * like a bug. Suspension stops the gym at the door and says why.
 *
 * ## What it does and does not touch
 *
 * Nothing is deleted, archived or downgraded. The gym's rows are left exactly
 * as they are and `resume` puts it back where it left off — that is the point
 * of having this rather than reaching for a delete. What changes is that every
 * request is refused: `requireAuth` blocks the app, and the sign-in paths
 * refuse too, so an owner is told what happened instead of being handed a
 * session that fails on its next request.
 *
 * The owner sees the reason, so write it for them rather than for yourself.
 *
 * Nothing here writes an audit row, for the same reason `setPlan.ts` does not:
 * the trail records what happens *inside* a gym, by somebody with a session.
 * This is an operator at a terminal with database credentials, and inventing
 * an actor for them would put a name in the log nobody signed in as.
 */

import 'dotenv/config';
import prisma from '../src/db.js';
import { PLAN_LABELS } from '../src/services/subscription.js';

/** Every gym, and whether it is currently stopped. */
const listGyms = async (): Promise<void> => {
  const gyms = await prisma.gym.findMany({
    select: {
      id: true,
      name: true,
      plan: true,
      suspendedAt: true,
      suspendedReason: true,
      _count: { select: { members: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (gyms.length === 0) {
    console.log('No gyms.');
    return;
  }

  for (const gym of gyms) {
    const state = gym.suspendedAt
      ? `SUSPENDED ${gym.suspendedAt.toISOString().slice(0, 10)}`
      : 'active';
    console.log(
      `${gym.id}  ${state.padEnd(21)}  ${PLAN_LABELS[gym.plan].padEnd(6)}  ` +
        `${String(gym._count.members).padStart(5)} members  ${gym.name}`,
    );
    if (gym.suspendedReason) {
      console.log(`${' '.repeat(38)}  reason: ${gym.suspendedReason}`);
    }
  }
};

const DEFAULT_REASON =
  "This gym's access has been suspended. Please contact support.";

const suspend = async (gymId: string, reason: string): Promise<void> => {
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
    select: { name: true, suspendedAt: true },
  });
  if (!gym) {
    console.error(`No gym with id ${gymId}.`);
    process.exitCode = 1;
    return;
  }
  if (gym.suspendedAt) {
    console.log(
      `${gym.name} is already suspended (since ` +
        `${gym.suspendedAt.toISOString().slice(0, 10)}). Updating the reason.`,
    );
  }

  await prisma.gym.update({
    where: { id: gymId },
    data: { suspendedAt: gym.suspendedAt ?? new Date(), suspendedReason: reason },
  });

  console.log(`${gym.name}: suspended.`);
  console.log(`Everyone there now sees: "${reason}"`);
};

const resume = async (gymId: string): Promise<void> => {
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
    select: { name: true, suspendedAt: true },
  });
  if (!gym) {
    console.error(`No gym with id ${gymId}.`);
    process.exitCode = 1;
    return;
  }
  if (!gym.suspendedAt) {
    console.log(`${gym.name} is not suspended. Nothing to do.`);
    return;
  }

  await prisma.gym.update({
    where: { id: gymId },
    data: { suspendedAt: null, suspendedReason: null },
  });

  console.log(`${gym.name}: resumed. Everything is exactly as they left it.`);
};

const main = async (): Promise<void> => {
  const [gymId, action, ...rest] = process.argv.slice(2);

  if (!gymId) {
    await listGyms();
    return;
  }

  if (action === 'suspend') {
    // Everything after the action is the reason, so it can be typed without
    // quotes and still read as one sentence.
    await suspend(gymId, rest.join(' ').trim() || DEFAULT_REASON);
    return;
  }

  if (action === 'resume') {
    await resume(gymId);
    return;
  }

  console.error(
    `Expected "suspend" or "resume" after the gym id.\n\n` +
      `  npx tsx scripts/suspendGym.ts ${gymId} suspend "Unpaid since March"\n` +
      `  npx tsx scripts/suspendGym.ts ${gymId} resume`,
  );
  process.exitCode = 1;
};

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
