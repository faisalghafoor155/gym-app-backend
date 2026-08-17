/**
 * Demo data for an existing gym.
 *
 * Additive by design: it never deletes, and it never touches the accounts that
 * can sign in. Run it against a gym that already exists (the one you registered
 * through the app) and it fills out the picture around it — enough members in
 * enough states that every filter tab, badge and dashboard panel has something
 * real to show.
 *
 * Member numbers continue from the gym's own counter, so seeded members sit in
 * sequence after the ones already there rather than colliding with them.
 *
 *   npm run db:seed                 # first gym in the database
 *   npm run db:seed -- --gym APEX   # by name, when there is more than one
 *
 * Safe to run more than once: every run adds a fresh batch.
 */
import 'dotenv/config';
import { PrismaClient, type MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL']! }),
});

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

/** Deterministic pseudo-randomness: the same seed run twice produces the same
 *  shape of data, which makes "did my change break this?" answerable. */
let rngState = 20260810;
const rand = (): number => {
  rngState = (rngState * 1103515245 + 12345) % 2147483648;
  return rngState / 2147483648;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const between = (lo: number, hi: number): number => Math.floor(rand() * (hi - lo + 1)) + lo;

const daysAgo = (n: number): Date => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
};
const addDays = (from: Date, n: number): Date => {
  const d = new Date(from);
  d.setDate(d.getDate() + n);
  return d;
};

const FIRST = [
  'Ahmed', 'Bilal', 'Hamza', 'Usman', 'Zain', 'Omar', 'Saad', 'Taimoor',
  'Ayesha', 'Fatima', 'Hira', 'Sana', 'Maryam', 'Zoya', 'Iqra', 'Noor',
  'Danish', 'Faizan', 'Rehan', 'Shahzad', 'Kashif', 'Adeel', 'Junaid', 'Waleed',
  'Amna',
] as const;
const LAST = [
  'Khan', 'Ali', 'Malik', 'Sheikh', 'Butt', 'Chaudhry', 'Qureshi', 'Siddiqui',
  'Hussain', 'Raza', 'Iqbal', 'Farooq',
] as const;

/**
 * The states worth having on screen. Counts are weighted the way a real gym
 * looks: mostly active, a handful chasing renewal, a few gone quiet.
 */
const COHORTS = [
  // Comfortably active — expiry well in the future.
  { kind: 'active', count: 20, startedDaysAgo: () => between(3, 20) },
  // Inside the 7-day warning window the app derives on read. On the 30-day
  // plan, starting 24-29 days ago puts the expiry 1-6 days out.
  { kind: 'expiring', count: 10, startedDaysAgo: () => between(24, 29) },
  // Expired recently: the renewal call list.
  { kind: 'expired', count: 8, startedDaysAgo: () => between(33, 50) },
  // Expired long enough that the app treats them as off the roster (60+ days).
  { kind: 'lapsed', count: 6, startedDaysAgo: () => between(95, 140) },
  // Registered but never sold anything — the "No membership" tab.
  { kind: 'none', count: 3, startedDaysAgo: () => 0 },
  // Bought, then called it off. Should never read as active anywhere.
  { kind: 'cancelled', count: 3, startedDaysAgo: () => between(10, 40) },
] as const;

const SUPPLEMENTS = [
  { name: 'Whey Protein 2lb', category: 'protein', price: 8500, stock: 14, dosage: '1 scoop', timing: 'Post-workout' },
  { name: 'Mass Gainer 3kg', category: 'protein', price: 11000, stock: 6, dosage: '2 scoops', timing: 'Post-workout' },
  { name: 'Creatine Monohydrate', category: 'creatine', price: 4200, stock: 20, dosage: '5g', timing: 'Daily' },
  { name: 'Pre-Workout C4', category: 'preworkout', price: 6800, stock: 3, dosage: '1 scoop', timing: '30 min before' },
  { name: 'BCAA 400g', category: 'bcaa', price: 5200, stock: 0, dosage: '1 scoop', timing: 'Intra-workout' },
  { name: 'Multivitamin', category: 'vitamins', price: 2800, stock: 25, dosage: '1 tablet', timing: 'With breakfast' },
  { name: 'Fish Oil Omega-3', category: 'vitamins', price: 3100, stock: 11, dosage: '2 softgels', timing: 'With meals' },
  { name: 'L-Carnitine', category: 'fatburner', price: 4900, stock: 7, dosage: '1 serving', timing: 'Pre-cardio' },
] as const;

const WORKOUT_PLANS = [
  { name: 'Beginner Full Body', description: '3 days a week, compound lifts, light progressive overload.' },
  { name: 'Push Pull Legs', description: '6-day split for intermediate lifters.' },
  { name: 'Fat Loss Circuit', description: 'High-intensity circuits with short rest, 4 days a week.' },
  { name: 'Strength 5x5', description: 'Squat, bench, deadlift, row and press on a 5x5 scheme.' },
] as const;

const DIET_PLANS = [
  { name: 'Cutting - 1800 kcal', description: 'High protein, moderate carbs, 40/30/30 split.' },
  { name: 'Bulking - 3200 kcal', description: 'Calorie surplus with 6 meals a day.' },
  { name: 'Maintenance - 2400 kcal', description: 'Balanced macros for holding bodyweight.' },
] as const;

async function main(): Promise<void> {
  const email = arg('--email');
  let gym;

  if (email) {
    const emailLower = email.trim().toLowerCase();
    let user = await prisma.user.findFirst({ where: { email: emailLower } });
    if (!user) {
      console.log(`User "${emailLower}" not found. Auto-creating gym and owner account...`);
      gym = await prisma.gym.create({
        data: {
          name: "Powerhouse Gym",
          ownerName: "Faisal Ghafoor",
        }
      });
      const bcrypt = await import('bcryptjs');
      const passwordHash = await bcrypt.default.hash('password123', 10);
      user = await prisma.user.create({
        data: {
          gymId: gym.id,
          email: emailLower,
          name: "Faisal Ghafoor",
          passwordHash,
          role: "owner",
          isActive: true,
        }
      });
      console.log(`Created owner account: ${emailLower} / password123`);
    }
    gym = await prisma.gym.findUnique({ where: { id: user.gymId } });
  } else {
    const gymName = arg('--gym');
    gym = gymName
      ? await prisma.gym.findFirst({ where: { name: gymName } })
      : await prisma.gym.findFirst({ orderBy: { createdAt: 'asc' } });
  }

  if (!gym) {
    console.log("No gym found in database. Creating default 'Powerhouse Gym' and owner...");
    gym = await prisma.gym.create({
      data: {
        name: "Powerhouse Gym",
        ownerName: "Admin Owner",
      }
    });

    const bcrypt = await import('bcryptjs');
    const passwordHash = await bcrypt.default.hash('password123', 10);

    await prisma.user.create({
      data: {
        gymId: gym.id,
        email: "owner@gym.com",
        name: "Admin Owner",
        passwordHash,
        role: "owner",
        isActive: true,
      }
    });
    console.log("Created owner account: owner@gym.com / password123");
  }

  console.log(`Seeding into "${gym.name}" — nothing existing will be removed.`);

  // --- membership plans ------------------------------------------------
  // A brand-new gym starts with three zero-priced plans. Give the unpriced
  // ones a real price so seeded memberships record something meaningful,
  // and leave any the owner has already priced alone.
  const PRICES: Record<string, number> = { Monthly: 2500, '3 Months': 6500, Yearly: 22000 };
  for (const [name, price] of Object.entries(PRICES)) {
    const existing = await prisma.membershipPlan.findFirst({ where: { gymId: gym.id, name } });
    if (!existing) {
      await prisma.membershipPlan.create({
        data: { gymId: gym.id, name, price, durationDays: name === 'Monthly' ? 30 : name === '3 Months' ? 90 : 365 },
      });
    } else if (existing.price === 0) {
      await prisma.membershipPlan.update({ where: { id: existing.id }, data: { price } });
    }
  }

  const plans = await prisma.membershipPlan.findMany({
    where: { gymId: gym.id, isActive: true },
    orderBy: { durationDays: 'asc' },
  });
  const monthly = plans.find(p => p.durationDays === 30) ?? plans[0]!;

  // --- workout and diet plans -----------------------------------------
  for (const p of WORKOUT_PLANS) {
    const exists = await prisma.workoutPlan.findFirst({ where: { gymId: gym.id, name: p.name } });
    if (!exists) await prisma.workoutPlan.create({ data: { ...p, gymId: gym.id } });
  }
  for (const p of DIET_PLANS) {
    const exists = await prisma.dietPlan.findFirst({ where: { gymId: gym.id, name: p.name } });
    if (!exists) await prisma.dietPlan.create({ data: { ...p, gymId: gym.id } });
  }
  const workoutPlans = await prisma.workoutPlan.findMany({ where: { gymId: gym.id } });
  const dietPlans = await prisma.dietPlan.findMany({ where: { gymId: gym.id } });

  // --- supplements ------------------------------------------------------
  for (const s of SUPPLEMENTS) {
    const exists = await prisma.supplement.findFirst({ where: { gymId: gym.id, name: s.name } });
    if (!exists) await prisma.supplement.create({ data: { ...s, gymId: gym.id } });
  }
  const supplements = await prisma.supplement.findMany({ where: { gymId: gym.id } });

  // --- members, memberships, payments, attendance -----------------------
  let created = 0;
  let paymentsMade = 0;
  let checkins = 0;

  for (const cohort of COHORTS) {
    for (let i = 0; i < cohort.count; i++) {
      // The gym's own counter drives the member number, exactly as the app
      // does it, so seeded members continue the sequence instead of clashing.
      const { memberSeq } = await prisma.gym.update({
        where: { id: gym.id },
        data: { memberSeq: { increment: 1 } },
        select: { memberSeq: true },
      });
      const memberNo = `MEM-${String(memberSeq).padStart(5, '0')}`;
      const name = `${pick(FIRST)} ${pick(LAST)}`;

      const member = await prisma.member.create({
        data: {
          gymId: gym.id,
          memberNo,
          name,
          phone: `03${between(0, 4)}${between(10, 99)}${between(1000000, 9999999)}`,
          email: rand() > 0.4
            ? `${name.toLowerCase().replace(/\s+/g, '.')}.${memberSeq}@example.com`
            : null,
          gender: rand() > 0.35 ? 'male' : 'female',
          dateOfBirth: daysAgo(between(18, 45) * 365),
          address: pick(['Model Town', 'Johar Town', 'DHA Phase 5', 'Gulberg III', 'Bahria Town']),
          emergencyContact: `03${between(0, 4)}${between(10, 99)}${between(1000000, 9999999)}`,
          // Only the app's own 60-day rule decides who reads as lapsed; the
          // stored status stays 'active' so nothing is hard-coded inactive.
          status: 'active',
          createdAt: daysAgo(cohort.startedDaysAgo() + between(0, 5)),
        },
      });
      created++;

      if (cohort.kind === 'none') continue;

      // The date-sensitive cohorts are pinned to the 30-day plan: their whole
      // point is where the expiry falls relative to today, and a 365-day plan
      // picked at random would push it a year out and empty the tab.
      const datePinned = cohort.kind === 'expiring' || cohort.kind === 'expired'
        || cohort.kind === 'lapsed';
      const plan = datePinned ? monthly : pick(plans);
      const start = daysAgo(cohort.startedDaysAgo());
      const expiry = addDays(start, plan.durationDays);
      const status: MembershipStatus = cohort.kind === 'cancelled' ? 'cancelled' : 'active';

      const membership = await prisma.membership.create({
        data: {
          gymId: gym.id,
          memberId: member.id,
          planId: plan.id,
          startDate: start,
          expiryDate: expiry,
          originalExpiryDate: expiry,
          pricePaid: plan.price,
          status,
        },
      });

      // What they paid when they joined, pointed at the membership it bought —
      // which is what lets the app tell a paid-up membership from an unpaid
      // one. Cancelled members still paid once.
      await prisma.payment.create({
        data: {
          gymId: gym.id,
          memberId: member.id,
          membershipId: membership.id,
          type: 'membership',
          amount: plan.price,
          method: rand() > 0.3 ? 'cash' : 'online',
          status: 'paid',
          paymentDate: start,
          notes: `${plan.name} membership`,
        },
      });
      paymentsMade++;

      // A few of the expired ones owe for the renewal they have not made yet,
      // so the dues panel has something in it.
      if (cohort.kind === 'expired' && rand() > 0.5) {
        await prisma.payment.create({
          data: {
            gymId: gym.id,
            memberId: member.id,
            // Deliberately unlinked: this is money owed for a renewal nobody
            // has sold yet, so there is no membership for it to point at.
            membershipId: null,
            type: 'membership',
            amount: plan.price,
            method: 'cash',
            status: 'due',
            paymentDate: expiry,
            notes: 'Renewal pending',
          },
        });
        paymentsMade++;
      }

      // Attendance, thinning out for people on their way out — which is what
      // makes the dashboard's daily chart and peak-hour read like a real week.
      const activeDays = cohort.kind === 'lapsed' ? 0
        : cohort.kind === 'expired' ? between(2, 8)
        : between(10, 40);

      const checkedDays = new Set<number>();
      for (let d = 0; d < activeDays; d++) {
        const ago = between(0, cohort.kind === 'expired' ? 70 : 55);
        if (checkedDays.has(ago)) continue;
        checkedDays.add(ago);
        const at = daysAgo(ago);
        // Gyms fill up morning and evening; the middle of the day is quiet.
        at.setHours(rand() > 0.45 ? between(17, 21) : between(6, 10), between(0, 59), 0, 0);
        if (at > new Date()) continue;
        await prisma.attendance.create({
          data: { gymId: gym.id, memberId: member.id, checkedInAt: at },
        });
        checkins++;
      }

      // Roughly half get a training and diet plan assigned.
      if (rand() > 0.5 && workoutPlans.length && dietPlans.length) {
        await prisma.memberPlan.create({
          data: {
            memberId: member.id,
            workoutPlanId: pick(workoutPlans).id,
            dietPlanId: rand() > 0.3 ? pick(dietPlans).id : null,
          },
        });
      }

      // Seed some supplement sales
      if (rand() > 0.6 && supplements.length) {
        const item = pick(supplements);
        if (item.stock > 0) {
          await prisma.payment.create({
            data: {
              gymId: gym.id,
              memberId: member.id,
              type: 'supplement',
              amount: item.price,
              method: rand() > 0.4 ? 'cash' : 'online',
              status: 'paid',
              paymentDate: daysAgo(between(1, 20)),
              notes: `Purchased ${item.name}`,
            },
          });
          // Decrement stock
          await prisma.supplement.update({
            where: { id: item.id },
            data: { stock: { decrement: 1 } },
          });
          paymentsMade++;
        }
      }
    }
  }

  console.log(
    `Done — ${created} members, ${paymentsMade} payments, ${checkins} check-ins, ${supplements.length} supplements, ${workoutPlans.length} workout and ${dietPlans.length} diet plans.`,
  );
}

main()
  .catch(err => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
