/**
 * Moves a gym onto a subscription tier.
 *
 * Billing is collected out of band — a bank transfer, a cash handover — so
 * there is no self-serve upgrade in the app and no way for an owner to change
 * their own tier. This is how a plan moves, run by whoever took the money:
 *
 *   npx tsx scripts/setPlan.ts                       # list every gym and its plan
 *   npx tsx scripts/setPlan.ts <gymId>               # show one gym's usage in detail
 *   npx tsx scripts/setPlan.ts <gymId> pro           # move it to Pro
 *
 * A downgrade is checked before it is applied. A gym on Pro with 400 members
 * does not fit on Basic, and moving it would leave the roster over its ceiling
 * with no way back in from the app — every existing member keeps working, but
 * the front desk cannot add the next one and nothing on screen explains why.
 * The script says what would be over and refuses; `--force` applies it anyway,
 * which is sometimes what you want when a gym is being wound down.
 *
 * Nothing here writes an audit row. The trail records what happens *inside* a
 * gym, by somebody with a session; this is an operator at a terminal with
 * database credentials, and inventing an actor for them would put a name in
 * the log that nobody signed in as.
 */

import 'dotenv/config';
import type { GymPlan } from '@prisma/client';
import prisma from '../src/db.js';
import {
  ENTITLEMENTS,
  PLAN_LABELS,
  PLAN_ORDER,
  usageFor,
  type PlanLimits,
} from '../src/services/subscription.js';

const isPlan = (v: string): v is GymPlan =>
  (PLAN_ORDER as readonly string[]).includes(v);

/** `null` means uncapped, which prints better than "null". */
const showLimit = (limit: number | null): string =>
  limit === null ? 'unlimited' : String(limit);

const LIMIT_NOUNS: Record<keyof PlanLimits, string> = {
  members: 'active members',
  staff: 'staff accounts',
  trainers: 'active trainers',
  classes: 'classes',
};

/** Every gym, its tier, and its roster size — enough to find the one you want. */
const listGyms = async (): Promise<void> => {
  const gyms = await prisma.gym.findMany({
    select: { id: true, name: true, plan: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  if (gyms.length === 0) {
    console.log('No gyms.');
    return;
  }

  console.log(`${gyms.length} gym(s):\n`);
  for (const gym of gyms) {
    const usage = await usageFor(gym.id);
    const limits = ENTITLEMENTS[gym.plan].limits;
    console.log(
      `  ${gym.id}  ${PLAN_LABELS[gym.plan].padEnd(6)} ` +
        `${usage.members}/${showLimit(limits.members)} members  ${gym.name}`,
    );
  }
  console.log('\nRun with a gym id to see one in detail.');
};

/** One gym's usage against its tier, limit by limit. */
const showGym = async (gymId: string): Promise<void> => {
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
    select: { id: true, name: true, plan: true },
  });
  if (!gym) {
    console.error(`No gym with id ${gymId}.`);
    process.exitCode = 1;
    return;
  }

  const usage = await usageFor(gym.id);
  const { limits, features } = ENTITLEMENTS[gym.plan];

  console.log(`${gym.name}`);
  console.log(`  plan: ${PLAN_LABELS[gym.plan]}\n`);
  console.log('  limits:');
  for (const key of Object.keys(limits) as (keyof PlanLimits)[]) {
    const over = limits[key] !== null && usage[key] > limits[key]!;
    console.log(
      `    ${LIMIT_NOUNS[key].padEnd(16)} ${usage[key]} / ${showLimit(limits[key])}` +
        (over ? '   ** over **' : ''),
    );
  }
  console.log('\n  features:');
  for (const [name, on] of Object.entries(features)) {
    console.log(`    ${name.padEnd(16)} ${on ? 'yes' : 'no'}`);
  }
};

/** Moves a gym, refusing a downgrade that would leave it over a ceiling. */
const setPlan = async (
  gymId: string,
  plan: GymPlan,
  force: boolean,
): Promise<void> => {
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
    select: { id: true, name: true, plan: true },
  });
  if (!gym) {
    console.error(`No gym with id ${gymId}.`);
    process.exitCode = 1;
    return;
  }

  if (gym.plan === plan) {
    console.log(`${gym.name} is already on ${PLAN_LABELS[plan]}.`);
    return;
  }

  const usage = await usageFor(gym.id);
  const target = ENTITLEMENTS[plan].limits;

  const over = (Object.keys(target) as (keyof PlanLimits)[])
    .filter((key) => target[key] !== null && usage[key] > target[key]!)
    .map(
      (key) =>
        `    ${LIMIT_NOUNS[key]}: ${usage[key]} in use, ${PLAN_LABELS[plan]} allows ${target[key]}`,
    );

  if (over.length > 0 && !force) {
    console.error(
      `${gym.name} does not fit on ${PLAN_LABELS[plan]}:\n${over.join('\n')}\n\n` +
        'Nothing existing stops working, but the gym cannot add any more of\n' +
        'these until it is back under the ceiling. Re-run with --force to\n' +
        'apply it anyway.',
    );
    process.exitCode = 1;
    return;
  }

  if (over.length > 0) {
    console.warn(`Applying anyway (--force). Over on:\n${over.join('\n')}\n`);
  }

  await prisma.gym.update({ where: { id: gymId }, data: { plan } });
  console.log(
    `${gym.name}: ${PLAN_LABELS[gym.plan]} → ${PLAN_LABELS[plan]}`,
  );
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const positional = args.filter((a) => !a.startsWith('--'));
  const [gymId, plan] = positional;

  if (!gymId) {
    await listGyms();
    return;
  }

  if (!plan) {
    await showGym(gymId);
    return;
  }

  if (!isPlan(plan)) {
    console.error(
      `"${plan}" is not a plan. Choose one of: ${PLAN_ORDER.join(', ')}.`,
    );
    process.exitCode = 1;
    return;
  }

  await setPlan(gymId, plan, force);
};

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
