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
 *
 * Needs `BIOMETRIC_KEY` in the environment, the same as the server: fingerprint
 * enrolments are encrypted on the way in, and seeding rows the app cannot read
 * back would be worse than seeding none.
 */
import 'dotenv/config';
import { PrismaClient, type MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { encryptTemplate } from '../src/services/fingerprint/crypto.js';

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

/**
 * How a seeded payment was taken, cash or wallet.
 *
 * Kept together so the pair is always consistent: a cash row with a channel is
 * a contradiction the API refuses, and seeded data that contains one would
 * have the books disagreeing with the rules that produced them.
 */
const takenBy = (cashChance: number): { method: string; channel: string | null } =>
  rand() > cashChance
    ? { method: 'cash', channel: null }
    : { method: 'online', channel: pick(['easypaisa', 'jazzcash', 'bank'] as const) };

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
  { kind: 'active', count: 42, startedDaysAgo: () => between(3, 20) },
  // Inside the 7-day warning window the app derives on read. On the 30-day
  // plan, starting 24-29 days ago puts the expiry 1-6 days out.
  { kind: 'expiring', count: 18, startedDaysAgo: () => between(24, 29) },
  // Expired recently: the renewal call list.
  { kind: 'expired', count: 16, startedDaysAgo: () => between(33, 50) },
  // Expired long enough that the app treats them as off the roster (60+ days),
  // but still inside the fingerprint retention window — their enrolment stays.
  { kind: 'lapsed', count: 11, startedDaysAgo: () => between(95, 140) },
  // Gone long enough that fingerprint retention deletes their template: more
  // than LAPSED_AFTER_DAYS + the grace window past expiry. On the 30-day plan
  // that means starting at least 180 days ago. Kept as its own cohort so the
  // retention job has something to actually find on a freshly seeded database
  // — without these, the job runs and correctly reports nothing to do, which
  // is indistinguishable from a job that is broken.
  { kind: 'departed', count: 9, startedDaysAgo: () => between(200, 320) },
  // Registered but never sold anything — the "No membership" tab.
  { kind: 'none', count: 7, startedDaysAgo: () => 0 },
  // Bought, then called it off. Should never read as active anywhere.
  { kind: 'cancelled', count: 6, startedDaysAgo: () => between(10, 40) },
] as const; // 109 members in total

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

/**
 * Trainers, priced deliberately unlike each other so the fee resolution has
 * something to show: one charges above the gym rate, one below, one is free,
 * and one leaves `ptFee` null so the gym default applies.
 */
const TRAINERS = [
  { name: 'Coach Bilal Ahmed', phone: '03001234501', specialization: 'Strength & Conditioning', commissionPercentage: 15, ptFee: 12000 },
  { name: 'Coach Sara Khan', phone: '03001234502', specialization: 'Weight Loss', commissionPercentage: 12, ptFee: 8000 },
  { name: 'Coach Usman Tariq', phone: '03001234503', specialization: 'Bodybuilding', commissionPercentage: 20, ptFee: null },
  { name: 'Coach Hina Malik', phone: '03001234504', specialization: 'Yoga & Mobility', commissionPercentage: 10, ptFee: 0 },
  { name: 'Coach Faizan Ali', phone: '03001234505', specialization: 'CrossFit', commissionPercentage: 18, ptFee: null },
] as const;

// Length lives on the schedule's start/end times, not on the class, so it is
// not a field here.
const CLASSES = [
  { name: 'Morning HIIT', description: 'Thirty minutes of high-intensity intervals.' },
  { name: 'Evening Yoga', description: 'Mobility and breathing, all levels welcome.' },
  { name: 'Spin Class', description: 'Indoor cycling to music.' },
  { name: 'Boxing Basics', description: 'Footwork, bag work and pad drills.' },
] as const;

/**
 * A month of running costs. Dated across the last three months so the profit
 * report has more than one period to compare, and spread over categories so
 * the breakdown is not one bar.
 */
const EXPENSES = [
  { category: 'rent', amount: 85000, vendor: 'Property Owner', notes: 'Monthly hall rent', monthly: true },
  { category: 'utilities', amount: 24000, vendor: 'K-Electric', notes: 'Electricity', monthly: true },
  { category: 'utilities', amount: 3500, vendor: 'SSGC', notes: 'Gas', monthly: true },
  { category: 'salaries', amount: 120000, vendor: null, notes: 'Floor staff salaries', monthly: true },
  { category: 'maintenance', amount: 8000, vendor: 'FitFix Services', notes: 'Treadmill belt replacement', monthly: false },
  { category: 'equipment', amount: 65000, vendor: 'Gym Tech Pk', notes: 'Two adjustable benches', monthly: false },
  { category: 'marketing', amount: 15000, vendor: 'Meta Ads', notes: 'Ramzan promotion', monthly: false },
  { category: 'supplies', amount: 4200, vendor: 'Metro Cash & Carry', notes: 'Cleaning supplies and towels', monthly: false },
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

  // --- gym pricing ------------------------------------------------------
  // The trainer fee falls back to this whenever a trainer sets no rate of its
  // own, so a seeded gym should have a real one rather than the honest 0 a
  // fresh gym starts with.
  if (gym.defaultPtFee.equals(0)) {
    await prisma.gym.update({ where: { id: gym.id }, data: { defaultPtFee: 10000 } });
  }
  // The accounts the front desk reads out when a member pays online. Seeded so
  // the channel picker has something to show rather than an empty hint.
  await prisma.gym.update({
    where: { id: gym.id },
    data: {
      easypaisaAccount: gym.easypaisaAccount ?? '0300-1234567',
      jazzcashAccount: gym.jazzcashAccount ?? '0301-7654321',
      bankAccount:
        gym.bankAccount ?? 'Meezan Bank — Iron Works Gym — PK36MEZN0001234567890123',
    },
  });
  const gymDefaultPtFee = gym.defaultPtFee.equals(0) ? 10000 : gym.defaultPtFee.toNumber();

  // --- trainers ---------------------------------------------------------
  for (const t of TRAINERS) {
    const exists = await prisma.trainer.findFirst({ where: { gymId: gym.id, name: t.name } });
    if (!exists) await prisma.trainer.create({ data: { ...t, gymId: gym.id } });
  }
  const trainers = await prisma.trainer.findMany({ where: { gymId: gym.id, isActive: true } });

  // --- classes and their weekly schedules -------------------------------
  for (const c of CLASSES) {
    const exists = await prisma.class.findFirst({ where: { gymId: gym.id, name: c.name } });
    if (!exists) await prisma.class.create({ data: { ...c, gymId: gym.id } });
  }
  const classes = await prisma.class.findMany({ where: { gymId: gym.id } });

  for (const cls of classes) {
    const already = await prisma.classSchedule.count({ where: { classId: cls.id } });
    if (already > 0) continue;
    // Two slots a week each, on days that do not all collide, so the weekly
    // grid has something in most columns.
    for (const dayOffset of [0, 3]) {
      const day = (classes.indexOf(cls) + dayOffset) % 7;
      const morning = cls.name.includes('Morning') || cls.name.includes('Spin');
      const startHour = morning ? 7 : 18;
      await prisma.classSchedule.create({
        data: {
          gymId: gym.id,
          classId: cls.id,
          trainerId: pick(trainers).id,
          dayOfWeek: day,
          startTime: `${String(startHour).padStart(2, '0')}:00`,
          endTime: `${String(startHour + 1).padStart(2, '0')}:00`,
          capacity: between(10, 25),
        },
      });
    }
  }
  const schedules = await prisma.classSchedule.findMany({ where: { gymId: gym.id } });

  // --- expenses ---------------------------------------------------------
  // Three months of them, so the profit report has periods to compare rather
  // than a single bar.
  let expensesAdded = 0;
  if ((await prisma.expense.count({ where: { gymId: gym.id } })) === 0) {
    for (let monthsBack = 0; monthsBack < 3; monthsBack++) {
      for (const e of EXPENSES) {
        // The one-off costs land in a single month; the running ones recur.
        if (!e.monthly && monthsBack !== between(0, 2)) continue;
        const spentOn = daysAgo(monthsBack * 30 + between(1, 25));
        await prisma.expense.create({
          data: {
            gymId: gym.id,
            category: e.category,
            // Utilities and salaries wobble month to month; rent does not.
            amount: e.category === 'rent' ? e.amount : Math.round(e.amount * (0.9 + rand() * 0.2)),
            spentOn,
            vendor: e.vendor,
            notes: e.notes,
          },
        });
        expensesAdded++;
      }
    }
  }

  // --- members, memberships, payments, attendance -----------------------
  let created = 0;
  let paymentsMade = 0;
  let checkins = 0;
  let ptSessionsMade = 0;
  let bookingsMade = 0;
  let salesMade = 0;
  let withTrainer = 0;
  let enrolled = 0;

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

      // About a third train with somebody. Lapsed members are left without —
      // they stopped coming, so a live trainer assignment would be odd.
      const trainer =
        cohort.kind !== 'lapsed' && cohort.kind !== 'departed'
        && cohort.kind !== 'none' && rand() > 0.65
          ? pick(trainers)
          : null;

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
          trainerId: trainer?.id ?? null,
        },
      });
      created++;

      // The one-off assignment fee, resolved the way the app resolves it:
      // the trainer's own rate, else the gym's. A rate of zero raises no
      // charge at all rather than a zero-rupee debt.
      if (trainer) {
        withTrainer++;
        const feeRate = trainer.ptFee === null ? gymDefaultPtFee : trainer.ptFee.toNumber();
        // A third of them haggled, so the "(agreed rate)" note has examples.
        const negotiated = rand() > 0.66 && feeRate > 0;
        const fee = negotiated ? Math.round((feeRate * (0.6 + rand() * 0.25)) / 500) * 500 : feeRate;
        if (fee > 0) {
          await prisma.payment.create({
            data: {
              gymId: gym.id,
              memberId: member.id,
              type: 'other',
              amount: fee,
              method: 'cash',
              // Most are collected at the counter; a few are left owing so the
              // outstanding column is not empty.
              status: rand() > 0.25 ? 'paid' : 'due',
              paymentDate: daysAgo(cohort.startedDaysAgo()),
              notes:
                `Trainer Fee (PT) for instructor: ${trainer.name}` +
                (negotiated ? ' (agreed rate)' : ''),
            },
          });
          paymentsMade++;
        }

        // Sessions actually delivered, with the trainer's commission worked
        // out the same way the app does — otherwise the commission report
        // would show sessions but no earnings.
        for (let s = 0; s < between(2, 10); s++) {
          const price = between(3, 8) * 500;
          const commission = Math.round((price * trainer.commissionPercentage.toNumber()) / 100);
          const when = daysAgo(between(0, 45));
          when.setHours(between(7, 20), 0, 0, 0);
          await prisma.ptSession.create({
            data: {
              gymId: gym.id,
              memberId: member.id,
              trainerId: trainer.id,
              sessionDate: when,
              priceCharged: price,
              trainerCommission: commission,
              status: when > new Date() ? 'scheduled' : pick(['completed', 'completed', 'cancelled']),
              paymentStatus: rand() > 0.3 ? 'paid' : 'unpaid',
            },
          });
          ptSessionsMade++;
        }
      }

      if (cohort.kind === 'none') continue;

      // The date-sensitive cohorts are pinned to the 30-day plan: their whole
      // point is where the expiry falls relative to today, and a 365-day plan
      // picked at random would push it a year out and empty the tab.
      const datePinned = cohort.kind === 'expiring' || cohort.kind === 'expired'
        || cohort.kind === 'lapsed' || cohort.kind === 'departed';
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
          ...takenBy(0.3),
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
      const activeDays = cohort.kind === 'lapsed' || cohort.kind === 'departed' ? 0
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

      // Fingerprint enrolment, for about half the roster.
      //
      // Encrypted through the same helper the enrolment endpoint uses, never
      // written raw: a seeded row the app cannot decrypt would look like a
      // corrupt enrolment and send somebody hunting a bug that is not there.
      // The bytes themselves are nonsense — no real reader produced them, and
      // nothing matches against them until one is plugged in.
      //
      // Enrolled on the day they joined, which is what the retention job
      // measures for a member who never bought anything.
      if (rand() > 0.5) {
        await prisma.fingerprintTemplate.create({
          data: {
            gymId: gym.id,
            memberId: member.id,
            template: encryptTemplate(
              Buffer.from(`seed-template-${memberNo}`),
              member.id,
            ),
            format: 'seed-v1',
            finger: pick(['right thumb', 'left thumb', 'right index'] as const),
            enrolledAt: daysAgo(cohort.startedDaysAgo()),
            enrolledBy: 'Seed data',
          },
        });
        enrolled++;
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

      // Supplement sales.
      //
      // A SupplementSale row as well as the payment, not just the payment:
      // the sales report and the stock ledger read the sale, so a payment on
      // its own would leave the Supplement Sales page empty while the money
      // showed up in revenue — books that disagree with each other.
      if (rand() > 0.55 && supplements.length) {
        const item = pick(supplements);
        const qty = rand() > 0.8 ? 2 : 1;
        if (item.stock >= qty && item.price) {
          const unitPrice = item.price;
          const total = unitPrice.mul(qty);
          const soldOn = daysAgo(between(1, 40));

          const payment = await prisma.payment.create({
            data: {
              gymId: gym.id,
              memberId: member.id,
              type: 'supplement',
              amount: total,
              ...takenBy(0.4),
              status: 'paid',
              paymentDate: soldOn,
              notes: `Purchased ${item.name}${qty > 1 ? ` x${qty}` : ''}`,
            },
          });
          await prisma.supplementSale.create({
            data: {
              gymId: gym.id,
              supplementId: item.id,
              memberId: member.id,
              quantity: qty,
              // Snapshotted, so a later price change does not rewrite what
              // this member was charged.
              unitPrice,
              total,
              paymentId: payment.id,
              soldAt: soldOn,
            },
          });
          await prisma.supplement.update({
            where: { id: item.id },
            data: { stock: { decrement: qty } },
          });
          // The in-memory copy has to move too, or a later member in this loop
          // reads a stock level the database no longer has and oversells it.
          item.stock -= qty;
          paymentsMade++;
          salesMade++;
        }
      }

      // Class bookings for members who are actually still coming.
      if (schedules.length && (cohort.kind === 'active' || cohort.kind === 'expiring') && rand() > 0.5) {
        const booked = new Set<string>();
        for (let b = 0; b < between(1, 3); b++) {
          const schedule = pick(schedules);
          const bookingDate = daysAgo(between(0, 14));
          bookingDate.setHours(0, 0, 0, 0);
          // One booking per member per schedule per day is a database
          // constraint, so a repeat pick has to be skipped rather than retried
          // into a crash.
          const key = `${schedule.id}:${bookingDate.toISOString()}`;
          if (booked.has(key)) continue;
          booked.add(key);
          await prisma.classBooking.create({
            data: {
              gymId: gym.id,
              scheduleId: schedule.id,
              memberId: member.id,
              bookingDate,
              status: bookingDate < new Date()
                ? pick(['attended', 'attended', 'cancelled'])
                : 'booked',
            },
          });
          bookingsMade++;
        }
      }
    }
  }

  console.log(
    [
      `Done — ${created} members (${withTrainer} with a trainer)`,
      `${paymentsMade} payments`,
      `${checkins} check-ins`,
      `${enrolled} fingerprints enrolled`,
      `${salesMade} supplement sales`,
      `${ptSessionsMade} PT sessions`,
      `${bookingsMade} class bookings`,
      `${expensesAdded} expenses`,
      `${trainers.length} trainers`,
      `${classes.length} classes on ${schedules.length} weekly slots`,
      `${supplements.length} supplements`,
      `${workoutPlans.length} workout and ${dietPlans.length} diet plans`,
    ].join(', ') + '.',
  );
}

main()
  .catch(err => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
