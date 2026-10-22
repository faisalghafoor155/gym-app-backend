/**
 * Replaces one gym's data with about four months of realistic demo data.
 *
 *   npx tsx scripts/seedDemoGym.ts owner@example.com --yes
 *
 * Finds the gym by its owner's email, deletes everything in that gym — members,
 * memberships, payments, attendance, stock, expenses, plans, classes and the
 * rest — and fills it again. Other gyms are not touched. Kept: the gym row and
 * its settings, its subscription, and every staff/owner login. Member logins
 * go with the members they belong to; one demo member login is created.
 *
 * Deterministic (seeded random), so two runs on the same day give the same gym.
 * Refuses to run without --yes, because the delete is the point.
 */
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import prisma from '../src/db.js';
import { formatMemberNo } from '../src/services/membership.js';

const email = process.argv[2];
if (!email || !process.argv.includes('--yes')) {
  console.error('Usage: npx tsx scripts/seedDemoGym.ts <owner-email> --yes');
  process.exit(1);
}

// --- deterministic randomness ------------------------------------------------

let seed = 20261022;
const rand = (): number => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const int = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const chance = (p: number) => rand() < p;
const weighted = <T>(xs: readonly [T, number][]): T => {
  const total = xs.reduce((t, [, w]) => t + w, 0);
  let r = rand() * total;
  for (const [x, w] of xs) { if ((r -= w) <= 0) return x; }
  return xs.at(-1)![0];
};

// --- dates -----------------------------------------------------------------------

const DAY = 86_400_000;
const today = new Date();
today.setHours(0, 0, 0, 0);
const DAYS_BACK = 120;
const dayAt = (offset: number, hour = 12, minute = 0): Date => {
  const d = new Date(today.getTime() + offset * DAY);
  d.setHours(hour, minute, 0, 0);
  return d;
};
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY);

// --- names ---------------------------------------------------------------------

const MALE = ['Ali', 'Ahmed', 'Hamza', 'Usman', 'Bilal', 'Hassan', 'Hussain', 'Umar', 'Zain', 'Saad', 'Faizan', 'Danish',
  'Talha', 'Waqas', 'Imran', 'Kamran', 'Adeel', 'Shahzaib', 'Asad', 'Haris', 'Junaid', 'Rizwan', 'Noman', 'Fahad',
  'Arslan', 'Shoaib', 'Moiz', 'Abdullah', 'Ibrahim', 'Sohail', 'Waleed', 'Raza', 'Taimoor', 'Muavia', 'Owais', 'Yasir'];
const FEMALE = ['Ayesha', 'Fatima', 'Zainab', 'Hira', 'Sana', 'Maryam', 'Amna', 'Iqra', 'Mahnoor', 'Areeba', 'Sara',
  'Noor', 'Rabia', 'Anum', 'Kinza', 'Laiba', 'Aiman', 'Mehwish'];
const SURNAMES = ['Khan', 'Ahmed', 'Malik', 'Butt', 'Sheikh', 'Chaudhry', 'Qureshi', 'Raza', 'Hussain', 'Iqbal',
  'Javed', 'Mirza', 'Abbasi', 'Siddiqui', 'Rana', 'Gill', 'Bhatti', 'Awan', 'Niazi', 'Shah', 'Ghafoor', 'Aslam'];
const AREAS = ['Gulberg', 'Model Town', 'Johar Town', 'DHA Phase 5', 'Iqbal Town', 'Township', 'Faisal Town', 'Wapda Town', 'Bahria Town', 'Garden Town'];

const phone = () => `03${pick(['00', '01', '02', '03', '05', '07', '08', '11', '12', '15', '21', '33', '45'])}${String(int(1000000, 9999999))}`;

const main = async () => {
  const owner = await prisma.user.findFirst({ where: { email, role: 'owner' }, select: { id: true, gymId: true, gym: { select: { name: true } } } });
  if (!owner) throw new Error(`No owner account with email ${email}`);
  const gymId = owner.gymId;
  const staff = await prisma.user.findMany({ where: { gymId, role: 'staff' }, select: { id: true } });
  const recorders = [owner.id, owner.id, ...staff.map(s => s.id)];
  console.log(`Gym "${owner.gym.name}" (${gymId}) — wiping and seeding…`);

  // --- wipe ------------------------------------------------------------------
  await prisma.$transaction(async (tx) => {
    const memberIds = (await tx.member.findMany({ where: { gymId }, select: { id: true } })).map(m => m.id);
    const membershipIds = (await tx.membership.findMany({ where: { gymId }, select: { id: true } })).map(m => m.id);
    await tx.promoRedemption.deleteMany({ where: { gymId } });
    await tx.promoCode.deleteMany({ where: { gymId } });
    await tx.referralReward.deleteMany({ where: { gymId } });
    await tx.locker.deleteMany({ where: { gymId } });
    await tx.memberMeasurement.deleteMany({ where: { gymId } });
    await tx.membershipFreeze.deleteMany({ where: { gymId } });
    await tx.greetingLog.deleteMany({ where: { gymId } });
    await tx.reminderLog.deleteMany({ where: { gymId } });
    await tx.classBooking.deleteMany({ where: { gymId } });
    await tx.classSchedule.deleteMany({ where: { gymId } });
    await tx.class.deleteMany({ where: { gymId } });
    await tx.ptSession.deleteMany({ where: { gymId } });
    await tx.paymentIntent.deleteMany({ where: { gymId } });
    await tx.supplementSale.deleteMany({ where: { gymId } });
    await tx.payment.deleteMany({ where: { gymId } });
    await tx.expense.deleteMany({ where: { gymId } });
    await tx.supplement.deleteMany({ where: { gymId } });
    await tx.memberPlan.deleteMany({ where: { memberId: { in: memberIds } } });
    await tx.workoutPlan.deleteMany({ where: { gymId } });
    await tx.dietPlan.deleteMany({ where: { gymId } });
    await tx.fingerprintTemplate.deleteMany({ where: { gymId } });
    await tx.attendance.deleteMany({ where: { gymId } });
    await tx.membership.deleteMany({ where: { id: { in: membershipIds } } });
    await tx.user.deleteMany({ where: { gymId, role: 'member' } });
    await tx.member.updateMany({ where: { gymId }, data: { referredById: null, trainerId: null } });
    await tx.member.deleteMany({ where: { gymId } });
    await tx.membershipPlan.deleteMany({ where: { gymId } });
    await tx.trainer.deleteMany({ where: { gymId } });
    await tx.auditLog.deleteMany({ where: { gymId } });
  }, { timeout: 120_000 });
  console.log('  wiped');

  await prisma.gym.update({
    where: { id: gymId },
    data: {
      joiningFee: 1000, defaultPtFee: 5000, referralRewardDays: 7, inactivityDays: 10,
      phone: '0300-1234567', address: 'Main Boulevard, Gulberg III, Lahore',
      easypaisaAccount: '0300-1234567', jazzcashAccount: '0301-7654321',
      bankAccount: 'Meezan Bank — MUSCLE GYM — PK36MEZN0001234567890123',
    },
  });

  // --- catalogue ---------------------------------------------------------------
  const planDefs = [
    { key: 'monthly', name: 'Monthly', price: 3000, durationDays: 30 },
    { key: 'quarterly', name: 'Quarterly', price: 8000, durationDays: 90 },
    { key: 'half', name: 'Half-Yearly', price: 15000, durationDays: 180 },
    { key: 'yearly', name: 'Yearly', price: 27000, durationDays: 365 },
    { key: 'ladies', name: 'Ladies Monthly', price: 2500, durationDays: 30 },
    { key: 'student', name: 'Student Monthly', price: 2200, durationDays: 30 },
  ] as const;
  const plans: Record<string, { id: string; name: string; price: number; durationDays: number }> = {};
  for (const p of planDefs) {
    const row = await prisma.membershipPlan.create({ data: { gymId, name: p.name, price: p.price, durationDays: p.durationDays, createdAt: dayAt(-DAYS_BACK - 5) } });
    plans[p.key] = { id: row.id, name: p.name, price: p.price, durationDays: p.durationDays };
  }

  const trainerDefs = [
    { name: 'Coach Usman Tariq', specialization: 'Bodybuilding', ptFee: 6000, commission: 40, phone: phone() },
    { name: 'Coach Saba Noor', specialization: 'Ladies Fitness & Yoga', ptFee: 5000, commission: 40, phone: phone() },
    { name: 'Coach Adnan Ali', specialization: 'CrossFit & Fat Loss', ptFee: 5500, commission: 35, phone: phone() },
    { name: 'Coach Kashif Mehmood', specialization: 'Powerlifting', ptFee: 7000, commission: 45, phone: phone() },
  ];
  const trainers = [];
  for (const t of trainerDefs) {
    trainers.push(await prisma.trainer.create({
      data: { gymId, name: t.name, phone: t.phone, specialization: t.specialization, ptFee: t.ptFee, commissionPercentage: t.commission, createdAt: dayAt(-DAYS_BACK - 5) },
    }));
  }

  const suppDefs = [
    { name: 'ON Gold Standard Whey 2lb', category: 'protein', price: 14500, cost: 11800, stock: 9, low: 4 },
    { name: 'Dymatize ISO100 5lb', category: 'protein', price: 32000, cost: 27000, stock: 3, low: 3 },
    { name: 'Kevin Levrone Anabolic Mass 3kg', category: 'protein', price: 9500, cost: 7400, stock: 12, low: 4 },
    { name: 'ON Serious Mass 6lb', category: 'protein', price: 13500, cost: 11000, stock: 2, low: 3 },
    { name: 'Creatine Monohydrate 300g', category: 'creatine', price: 5500, cost: 3900, stock: 18, low: 5 },
    { name: 'C4 Original Pre-Workout', category: 'preworkout', price: 7500, cost: 5800, stock: 0, low: 3 },
    { name: 'Psychotic Pre-Workout', category: 'preworkout', price: 8200, cost: 6400, stock: 6, low: 3 },
    { name: 'Xtend BCAA 30 serv', category: 'bcaa', price: 6800, cost: 5200, stock: 7, low: 3 },
    { name: 'Multivitamin Opti-Men', category: 'vitamins', price: 6200, cost: 4700, stock: 10, low: 4 },
    { name: 'Omega-3 Fish Oil 100 caps', category: 'vitamins', price: 3200, cost: 2100, stock: 15, low: 5 },
    { name: 'Hydroxycut Hardcore', category: 'fatburner', price: 6900, cost: 5100, stock: 4, low: 4 },
    { name: 'Shaker Bottle', category: 'other', price: 800, cost: 350, stock: 25, low: 8 },
  ] as const;
  const supplements = [];
  for (const s of suppDefs) {
    supplements.push(await prisma.supplement.create({
      data: {
        gymId, name: s.name, category: s.category, price: s.price, costPrice: s.cost, stock: s.stock, lowStockAt: s.low,
        dosage: s.category === 'protein' ? '1 scoop (30g)' : s.category === 'creatine' ? '5g daily' : null,
        timing: s.category === 'preworkout' ? '20–30 min before workout' : s.category === 'protein' ? 'Post-workout' : null,
        createdAt: dayAt(-DAYS_BACK - 5),
      },
    }));
  }

  const ex = (name: string, sets: number, reps: string, weight = '') => ({ name, sets, reps, weight });
  const workoutDefs = [
    {
      name: 'Beginner Full Body (3 days)', description: 'For the first 8 weeks. Focus on form, not weight.',
      days: [
        { day: 'Monday', exercises: [ex('Goblet Squat', 3, '12'), ex('Dumbbell Bench Press', 3, '10'), ex('Lat Pulldown', 3, '12'), ex('Plank', 3, '30s')] },
        { day: 'Wednesday', exercises: [ex('Leg Press', 3, '12'), ex('Seated Shoulder Press', 3, '10'), ex('Seated Cable Row', 3, '12'), ex('Crunches', 3, '15')] },
        { day: 'Friday', exercises: [ex('Romanian Deadlift', 3, '10'), ex('Incline Dumbbell Press', 3, '10'), ex('Assisted Pull-ups', 3, '8'), ex('Bicep Curl', 2, '12'), ex('Triceps Pushdown', 2, '12')] },
      ],
    },
    {
      name: 'Push Pull Legs (6 days)', description: 'Intermediate hypertrophy split. Progressive overload every week.',
      days: [
        { day: 'Monday', exercises: [ex('Bench Press', 4, '6-8', '60'), ex('Incline DB Press', 3, '8-10', '22'), ex('Shoulder Press', 3, '8-10'), ex('Lateral Raise', 4, '15'), ex('Skull Crushers', 3, '10')] },
        { day: 'Tuesday', exercises: [ex('Deadlift', 4, '5', '100'), ex('Pull-ups', 4, '8'), ex('Barbell Row', 3, '8-10'), ex('Face Pull', 3, '15'), ex('Hammer Curl', 3, '12')] },
        { day: 'Wednesday', exercises: [ex('Back Squat', 4, '6-8', '80'), ex('Leg Press', 3, '12'), ex('Leg Curl', 3, '12'), ex('Calf Raise', 4, '15')] },
        { day: 'Thursday', exercises: [ex('Overhead Press', 4, '6-8', '40'), ex('Weighted Dips', 3, '8'), ex('Cable Fly', 3, '12'), ex('Lateral Raise', 4, '15')] },
        { day: 'Friday', exercises: [ex('Weighted Pull-ups', 4, '6'), ex('T-Bar Row', 3, '8-10'), ex('Lat Pulldown', 3, '12'), ex('Barbell Curl', 3, '10')] },
        { day: 'Saturday', exercises: [ex('Front Squat', 4, '8', '60'), ex('Walking Lunges', 3, '12'), ex('Romanian Deadlift', 3, '10'), ex('Hanging Leg Raise', 3, '12')] },
      ],
    },
    {
      name: 'Fat Loss Circuit (5 days)', description: 'Supersets with short rest, 20 min cardio after every session.',
      days: [
        { day: 'Monday', exercises: [ex('Kettlebell Swing', 4, '15'), ex('Push-ups', 4, '12'), ex('Jump Squats', 4, '15'), ex('Treadmill Incline Walk', 1, '20 min')] },
        { day: 'Tuesday', exercises: [ex('Rowing Machine', 1, '15 min'), ex('Battle Ropes', 4, '30s'), ex('Mountain Climbers', 4, '30s')] },
        { day: 'Thursday', exercises: [ex('Burpees', 4, '10'), ex('Dumbbell Thrusters', 4, '12'), ex('TRX Row', 4, '12'), ex('Cycling', 1, '20 min')] },
        { day: 'Friday', exercises: [ex('Box Jumps', 4, '10'), ex('Walking Lunges', 4, '20'), ex('Plank', 3, '45s')] },
        { day: 'Saturday', exercises: [ex('Stair Climber', 1, '25 min'), ex('Russian Twist', 3, '20'), ex('Bicycle Crunch', 3, '20')] },
      ],
    },
  ];
  const workoutPlans = [];
  for (const w of workoutDefs) {
    workoutPlans.push(await prisma.workoutPlan.create({ data: { gymId, name: w.name, description: w.description, workoutData: { days: w.days }, createdAt: dayAt(-DAYS_BACK) } }));
  }
  const food = (name: string, amount: string, calories: number) => ({ name, amount, calories });
  const dietDefs = [
    {
      name: 'Lean Bulk — Desi (2,800 kcal)', description: 'High protein Pakistani diet for muscle gain.',
      meals: [
        { name: 'Breakfast', items: [food('Boiled eggs', '4', 310), food('Paratha (less oil)', '1', 260), food('Milk', '1 glass', 150)] },
        { name: 'Lunch', items: [food('Chicken karahi', '200g', 420), food('Roti', '2', 240), food('Raita', '1 bowl', 90)] },
        { name: 'Pre-workout', items: [food('Banana', '2', 210), food('Black coffee', '1 cup', 5)] },
        { name: 'Post-workout', items: [food('Whey protein', '1 scoop', 120), food('Oats', '60g', 230)] },
        { name: 'Dinner', items: [food('Daal chawal', '1 plate', 480), food('Grilled chicken', '150g', 250), food('Salad', '1 bowl', 40)] },
      ],
    },
    {
      name: 'Fat Loss — Desi (1,800 kcal)', description: 'Calorie deficit with enough protein to keep muscle.',
      meals: [
        { name: 'Breakfast', items: [food('Egg white omelette', '4 whites', 70), food('Brown bread', '1 slice', 80), food('Green tea', '1 cup', 0)] },
        { name: 'Lunch', items: [food('Chicken tikka', '200g', 330), food('Roti', '1', 120), food('Salad', '1 bowl', 40)] },
        { name: 'Snack', items: [food('Apple', '1', 95), food('Almonds', '10', 70)] },
        { name: 'Dinner', items: [food('Fish (grilled)', '150g', 230), food('Sabzi', '1 bowl', 150), food('Dahi', '1 bowl', 120)] },
      ],
    },
    {
      name: 'Ladies Toning (1,600 kcal)', description: 'Balanced meals, moderate deficit.',
      meals: [
        { name: 'Breakfast', items: [food('Oats with milk', '1 bowl', 280), food('Boiled egg', '2', 155)] },
        { name: 'Lunch', items: [food('Chicken salad', '1 bowl', 320), food('Roti', '1', 120)] },
        { name: 'Snack', items: [food('Greek yogurt', '150g', 130), food('Berries', '1 cup', 60)] },
        { name: 'Dinner', items: [food('Daal', '1 bowl', 230), food('Brown rice', '1 cup', 215)] },
      ],
    },
  ];
  const dietPlans = [];
  for (const d of dietDefs) {
    dietPlans.push(await prisma.dietPlan.create({ data: { gymId, name: d.name, description: d.description, dietData: { meals: d.meals }, createdAt: dayAt(-DAYS_BACK) } }));
  }

  const classDefs = [
    { name: 'Zumba', description: 'High-energy dance cardio', trainer: 1, slots: [[1, '18:00', '19:00'], [3, '18:00', '19:00'], [5, '18:00', '19:00']] },
    { name: 'CrossFit WOD', description: 'Workout of the day — scaled for all levels', trainer: 2, slots: [[2, '07:00', '08:00'], [4, '07:00', '08:00'], [6, '08:00', '09:00']] },
    { name: 'Ladies Yoga', description: 'Mobility, flexibility and breathing', trainer: 1, slots: [[2, '11:00', '12:00'], [4, '11:00', '12:00']] },
    { name: 'Boxing Fitness', description: 'Pad work, bag work and conditioning', trainer: 3, slots: [[1, '20:00', '21:00'], [3, '20:00', '21:00']] },
  ] as const;
  const schedules: { id: string; dayOfWeek: number }[] = [];
  for (const c of classDefs) {
    const cls = await prisma.class.create({ data: { gymId, name: c.name, description: c.description, createdAt: dayAt(-DAYS_BACK) } });
    for (const [dow, start, end] of c.slots) {
      const s = await prisma.classSchedule.create({ data: { gymId, classId: cls.id, trainerId: trainers[c.trainer]!.id, dayOfWeek: dow, startTime: start, endTime: end, capacity: 15 } });
      schedules.push({ id: s.id, dayOfWeek: dow });
    }
  }

  const promoDefs = [
    { code: 'FAMILY10', description: 'Family members joining together', kind: 'percent', value: 10, from: null, until: null, max: null },
    { code: 'STUDENT15', description: 'Students with a valid card', kind: 'percent', value: 15, from: null, until: null, max: null },
    { code: 'AZADI14', description: 'Independence Day offer', kind: 'percent', value: 14, from: dayAt(-85), until: dayAt(-60), max: 50 },
    { code: 'WINTER500', description: 'Rs. 500 off for the winter season', kind: 'fixed', value: 500, from: dayAt(-10), until: dayAt(60), max: 40 },
  ] as const;
  const promos = [];
  for (const p of promoDefs) {
    promos.push(await prisma.promoCode.create({
      data: { gymId, code: p.code, description: p.description, kind: p.kind, value: p.value, validFrom: p.from, validUntil: p.until, maxUses: p.max, createdAt: dayAt(-DAYS_BACK) },
    }));
  }
  const promoUses = new Map<string, number>();

  // --- members, memberships, payments ------------------------------------------
  type Seeded = { id: string; name: string; gender: string; joinOffset: number; regularity: number; morning: boolean; quitsAt: number | null; trainerIdx: number | null };
  const members: Seeded[] = [];
  const membershipRows: Prisma.MembershipCreateManyInput[] = [];
  const paymentRows: Prisma.PaymentCreateManyInput[] = [];
  const redemptions: Prisma.PromoRedemptionCreateManyInput[] = [];
  const usedNames = new Set<string>();
  const MEMBER_COUNT = 96;
  const birthdayToday = new Set([4, 37, 71]);

  for (let i = 0; i < MEMBER_COUNT; i++) {
    const gender = chance(0.72) ? 'male' : 'female';
    let name = '';
    do { name = `${pick(gender === 'male' ? MALE : FEMALE)} ${pick(SURNAMES)}`; } while (usedNames.has(name));
    usedNames.add(name);

    // A launch wave in the first two weeks, then a steady trickle of joiners.
    const joinOffset = i < 38 ? -DAYS_BACK + int(0, 14) : int(-DAYS_BACK + 15, -1);
    const joinedAt = dayAt(joinOffset, int(9, 21), int(0, 59));
    const age = gender === 'male' ? int(17, 45) : int(18, 40);
    const dob = birthdayToday.has(i)
      ? new Date(Date.UTC(today.getFullYear() - age, today.getMonth(), today.getDate()))
      : new Date(Date.UTC(today.getFullYear() - age, int(0, 11), int(1, 28)));

    const member = await prisma.member.create({
      data: {
        gymId, memberNo: formatMemberNo(i + 1), name, gender,
        phone: chance(0.95) ? phone() : null,
        email: chance(0.35) ? `${name.toLowerCase().replace(/\s+/g, '.')}${int(1, 99)}@gmail.com` : null,
        dateOfBirth: dob,
        address: `House ${int(1, 400)}, ${pick(AREAS)}, Lahore`,
        emergencyContact: chance(0.6) ? phone() : null,
        createdAt: joinedAt,
      },
    });

    const regularity = weighted([[0.8, 3], [0.6, 4], [0.4, 3], [0.2, 1]] as [number, number][]) + rand() * 0.1;
    // ~12% of members stop coming at some point; their membership may still run.
    const quitsAt = chance(0.12) ? int(Math.max(joinOffset + 10, -60), -11) : null;
    members.push({
      id: member.id, name, gender, joinOffset, regularity, morning: chance(0.4), quitsAt,
      trainerIdx: chance(0.2) ? (gender === 'female' ? 1 : pick([0, 2, 3])) : null,
    });

    // The membership chain from the day they joined until today.
    const firstPlan = gender === 'female' && chance(0.6) ? plans.ladies!
      : chance(0.12) ? plans.student!
      : weighted([[plans.monthly!, 60], [plans.quarterly!, 22], [plans.half!, 10], [plans.yearly!, 4]] as [typeof plans[string], number][]);
    let plan = firstPlan;
    let start = new Date(joinedAt); start.setHours(0, 0, 0, 0);
    let first = true;
    const willLapse = chance(0.3);
    for (;;) {
      const expiry = addDays(start, plan.durationDays);
      const isLast = expiry >= today || (willLapse && chance(first ? 0.35 : 0.5));
      const id = crypto.randomUUID();

      // A discount, sometimes.
      let price = plan.price;
      let promo: (typeof promos)[number] | null = null;
      if (chance(0.12)) {
        const candidates = promos.filter(p => (!p.validFrom || p.validFrom <= start) && (!p.validUntil || p.validUntil >= start));
        if (candidates.length) {
          promo = pick(candidates);
          const off = promo.kind === 'percent' ? Math.round((price * promo.value.toNumber()) / 100) : Math.min(price, promo.value.toNumber());
          price -= off;
          redemptions.push({ gymId, promoCodeId: promo.id, memberId: member.id, membershipId: id, discount: off, createdAt: start });
          promoUses.set(promo.id, (promoUses.get(promo.id) ?? 0) + 1);
        }
      }

      membershipRows.push({
        id, gymId, memberId: member.id, planId: plan.id, startDate: start, expiryDate: expiry,
        pricePaid: price, status: isLast ? 'active' : 'superseded', createdAt: dayAt(daysBetween(today, start), int(9, 21)),
      });

      // Paid in full mostly; a few pay part now and owe the rest.
      const partial = isLast && chance(0.14);
      const paid = partial ? Math.round((price * pick([0.4, 0.5, 0.6, 0.7])) / 100) * 100 : price;
      const payDate = dayAt(daysBetween(today, start), int(9, 22), int(0, 59));
      if (payDate <= new Date()) {
        paymentRows.push({
          gymId, memberId: member.id, membershipId: id, amount: paid, paymentDate: payDate,
          method: chance(0.7) ? 'cash' : 'online',
          status: 'paid', type: 'membership', recordedById: pick(recorders),
          notes: first ? `New membership — ${plan.name}` : `Renewal — ${plan.name}`,
        });
        // A later instalment for some part-payers.
        if (partial && chance(0.4) && daysBetween(start, today) > 10) {
          paymentRows.push({
            gymId, memberId: member.id, membershipId: id, amount: Math.round((price - paid) / 2 / 100) * 100,
            paymentDate: addDays(payDate, int(5, 10)), method: 'cash', status: 'paid', type: 'membership',
            recordedById: pick(recorders), notes: 'Instalment',
          });
        }
      }
      if (first) {
        paymentRows.push({
          gymId, memberId: member.id, amount: 1000, paymentDate: payDate, method: 'cash', status: 'paid',
          type: 'other', recordedById: pick(recorders), notes: 'Joining fee',
        });
      }

      if (isLast) break;
      first = false;
      start = expiry;
      // Most renew onto the same plan; a few move up.
      if (plan === plans.monthly && chance(0.15)) plan = plans.quarterly!;
    }
  }
  await prisma.gym.update({ where: { id: gymId }, data: { memberSeq: MEMBER_COUNT } });
  await prisma.membership.createMany({ data: membershipRows });
  await prisma.payment.createMany({ data: paymentRows });
  await prisma.promoRedemption.createMany({ data: redemptions });
  for (const [id, n] of promoUses) await prisma.promoCode.update({ where: { id }, data: { usedCount: n } });

  // A couple of hand-paused and called-off memberships.
  const current = await prisma.membership.findMany({ where: { gymId, status: 'active' }, select: { id: true, memberId: true, expiryDate: true, startDate: true } });
  const running = current.filter(m => m.expiryDate >= today);
  for (const m of running.slice(0, 2)) await prisma.membership.update({ where: { id: m.id }, data: { status: 'suspended' } });

  // Freezes: one running now, one booked, one finished.
  const freezeTargets = running.slice(5, 8);
  const freezePlans = [{ start: -4, days: 14, reason: 'Travel — Umrah' }, { start: 6, days: 10, reason: 'Exams' }, { start: -40, days: 15, reason: 'Injury — knee' }];
  for (const [i, m] of freezeTargets.entries()) {
    const f = freezePlans[i]!;
    const from = dayAt(f.start, 0);
    if (f.start < 0 && from < m.startDate) continue;
    await prisma.membershipFreeze.create({ data: { gymId, membershipId: m.id, startDate: from, days: f.days, reason: f.reason, createdAt: dayAt(Math.min(f.start, -1)) } });
    await prisma.membership.update({ where: { id: m.id }, data: { expiryDate: addDays(m.expiryDate, f.days), frozenFrom: from, frozenUntil: addDays(from, f.days) } });
  }

  // Trainers and PT.
  for (const s of members.filter(m => m.trainerIdx !== null)) {
    const trainer = trainers[s.trainerIdx!]!;
    const fee = trainerDefs[s.trainerIdx!]!.ptFee;
    await prisma.member.update({ where: { id: s.id }, data: { trainerId: trainer.id } });
    const assigned = dayAt(Math.max(s.joinOffset, -DAYS_BACK) + int(0, 20), int(10, 20));
    if (assigned < new Date()) {
      await prisma.payment.create({
        data: { gymId, memberId: s.id, amount: fee, paymentDate: assigned, method: 'cash', status: chance(0.85) ? 'paid' : 'due', type: 'other', recordedById: owner.id, notes: `Trainer Fee (PT) — ${trainer.name}` },
      });
    }
    const sessions = int(4, 14);
    for (let k = 0; k < sessions; k++) {
      const when = dayAt(int(Math.max(s.joinOffset, -DAYS_BACK) + 2, 6), int(7, 21));
      const past = when < new Date();
      const price = Math.round(fee / 8);
      await prisma.ptSession.create({
        data: {
          gymId, memberId: s.id, trainerId: trainer.id, sessionDate: when, priceCharged: price,
          trainerCommission: Math.round((price * trainerDefs[s.trainerIdx!]!.commission) / 100),
          status: past ? (chance(0.9) ? 'completed' : 'cancelled') : 'scheduled',
          paymentStatus: past && chance(0.8) ? 'paid' : 'unpaid',
          payoutStatus: past && chance(0.5) ? 'paid' : 'unpaid',
          createdAt: addDays(when, -2),
        },
      });
    }
  }
  console.log(`  ${MEMBER_COUNT} members, ${membershipRows.length} memberships`);

  // --- attendance ------------------------------------------------------------
  const allMemberships = await prisma.membership.findMany({ where: { gymId }, select: { memberId: true, startDate: true, expiryDate: true, status: true, frozenFrom: true, frozenUntil: true } });
  const byMember = new Map<string, typeof allMemberships>();
  for (const m of allMemberships) byMember.set(m.memberId, [...(byMember.get(m.memberId) ?? []), m]);
  const attendance: Prisma.AttendanceCreateManyInput[] = [];
  for (const s of members) {
    const ms = byMember.get(s.id) ?? [];
    for (let d = Math.max(s.joinOffset, -DAYS_BACK); d <= 0; d++) {
      const day = dayAt(d, 0);
      const covering = ms.find(m => m.startDate <= day && m.expiryDate >= day && m.status !== 'suspended'
        && !(m.frozenFrom && m.frozenUntil && m.frozenFrom <= day && m.frozenUntil > day));
      if (!covering) continue;
      if (s.quitsAt !== null && d >= s.quitsAt) continue;
      const dow = day.getDay();
      const p = s.regularity * (dow === 0 ? 0.35 : dow === 5 ? 0.75 : 1);
      if (!chance(p)) continue;
      const at = s.morning ? dayAt(d, int(6, 10), int(0, 59)) : dayAt(d, int(17, 22), int(0, 59));
      if (at > new Date()) continue;
      attendance.push({ gymId, memberId: s.id, checkedInAt: at });
    }
  }
  for (let i = 0; i < attendance.length; i += 2000) {
    await prisma.attendance.createMany({ data: attendance.slice(i, i + 2000), skipDuplicates: true });
  }
  console.log(`  ${attendance.length} check-ins`);

  // --- supplement sales --------------------------------------------------------
  const sales: Prisma.SupplementSaleCreateManyInput[] = [];
  const salePayments: Prisma.PaymentCreateManyInput[] = [];
  for (let d = -DAYS_BACK; d <= 0; d++) {
    const n = weighted([[0, 50], [1, 35], [2, 15]] as [number, number][]);
    for (let k = 0; k < n; k++) {
      const s = pick(supplements.filter(x => x.category !== 'other' || chance(0.5)));
      const qty = s.category === 'other' ? int(1, 2) : 1;
      const when = dayAt(d, int(10, 22), int(0, 59));
      if (when > new Date()) continue;
      const buyer = chance(0.6) ? pick(members.filter(m => m.joinOffset <= d)) : null;
      const total = s.price!.toNumber() * qty;
      let paymentId: string | null = null;
      if (buyer) {
        paymentId = crypto.randomUUID();
        salePayments.push({ id: paymentId, gymId, memberId: buyer.id, amount: total, paymentDate: when, method: chance(0.75) ? 'cash' : 'online', status: 'paid', type: 'supplement', recordedById: pick(recorders), notes: `${s.name} × ${qty}` });
      }
      sales.push({ gymId, supplementId: s.id, memberId: buyer?.id ?? null, quantity: qty, unitPrice: s.price!, total, unitCost: s.costPrice, paymentId, soldAt: when });
    }
  }
  await prisma.payment.createMany({ data: salePayments });
  await prisma.supplementSale.createMany({ data: sales });
  console.log(`  ${sales.length} supplement sales`);

  // --- expenses ----------------------------------------------------------------
  const expenses: Prisma.ExpenseCreateManyInput[] = [];
  for (let m = 3; m >= 0; m--) {
    const first = new Date(today.getFullYear(), today.getMonth() - m, 1, 12);
    const at = (dayOfMonth: number) => new Date(first.getFullYear(), first.getMonth(), dayOfMonth, 12);
    const inRange = (d: Date) => d <= new Date() && d >= dayAt(-DAYS_BACK - 5);
    const push = (d: Date, category: string, amount: number, vendor: string | null, notes: string | null) => {
      if (inRange(d)) expenses.push({ gymId, category, amount, spentOn: d, vendor, notes, recordedById: owner.id });
    };
    push(at(1), 'rent', 70000, 'Building owner', 'Monthly rent');
    push(at(5), 'salaries', 40000, null, 'Coach Usman Tariq');
    push(at(5), 'salaries', 30000, null, 'Coach Saba Noor');
    push(at(5), 'salaries', 30000, null, 'Coach Adnan Ali');
    push(at(5), 'salaries', 25000, null, 'Front desk');
    push(at(5), 'salaries', 15000, null, 'Cleaner');
    push(at(10), 'utilities', int(32000, 48000), 'LESCO', 'Electricity bill');
    push(at(12), 'utilities', int(2500, 4000), 'WASA', 'Water bill');
    push(at(12), 'utilities', 4500, 'PTCL', 'Internet');
    push(at(int(14, 20)), 'supplies', int(15000, 40000), 'Supplement distributor', 'Supplement restock');
    if (chance(0.7)) push(at(int(15, 25)), 'maintenance', int(4000, 18000), pick(['Treadmill technician', 'AC service', 'Plumber']), null);
    if (chance(0.6)) push(at(int(8, 20)), 'marketing', int(5000, 15000), pick(['Facebook ads', 'Flex printing', 'Instagram promotion']), null);
    if (m === 2) push(at(18), 'equipment', 85000, 'Fitness Hub Lahore', 'New dumbbell rack + 2 benches');
    push(at(int(20, 27)), 'supplies', int(2000, 5000), 'Local store', 'Cleaning supplies, tissue, sanitizer');
  }
  await prisma.expense.createMany({ data: expenses });

  // --- measurements, plans, referrals, lockers, bookings -------------------------
  const measured = members.filter((_, i) => i % 4 === 0).slice(0, 24);
  const meas: Prisma.MemberMeasurementCreateManyInput[] = [];
  for (const s of measured) {
    const cutting = chance(0.5);
    let weight = s.gender === 'male' ? int(62, 98) : int(52, 80);
    let fat = s.gender === 'male' ? int(14, 28) : int(22, 34);
    let waist = s.gender === 'male' ? int(78, 102) : int(68, 90);
    for (let d = Math.max(s.joinOffset, -DAYS_BACK) + 1; d <= 0; d += int(12, 18)) {
      meas.push({
        gymId, memberId: s.id, measuredOn: dayAt(d, 12),
        weightKg: weight, bodyFatPct: fat, waistCm: waist,
        chestCm: s.gender === 'male' ? int(92, 108) : null, armCm: s.gender === 'male' ? int(31, 40) : int(25, 30),
        recordedById: pick(recorders),
      });
      weight = Math.round((weight + (cutting ? -rand() * 1.6 : rand() * 1.2)) * 10) / 10;
      fat = Math.round((fat + (cutting ? -rand() * 1.1 : rand() * 0.3)) * 10) / 10;
      waist = Math.round((waist + (cutting ? -rand() * 1.4 : rand() * 0.4)) * 10) / 10;
    }
  }
  await prisma.memberMeasurement.createMany({ data: meas });

  for (const s of members.filter((_, i) => i % 3 === 0)) {
    await prisma.memberPlan.create({
      data: {
        memberId: s.id,
        workoutPlanId: pick(workoutPlans).id,
        dietPlanId: s.gender === 'female' ? dietPlans[2]!.id : pick(dietPlans.slice(0, 2)).id,
        assignedAt: dayAt(Math.max(s.joinOffset, -DAYS_BACK) + 2),
      },
    });
  }

  // Referrals: later joiners brought in by earlier ones.
  const early = members.filter(m => m.joinOffset < -90);
  for (const s of members.filter(m => m.joinOffset > -90).slice(0, 14)) {
    const referrer = pick(early);
    const granted = s.joinOffset < -20 && chance(0.7);
    await prisma.member.update({ where: { id: s.id }, data: { referredById: referrer.id } });
    await prisma.referralReward.create({
      data: {
        gymId, referrerId: referrer.id, referredId: s.id, rewardDays: 7,
        status: granted ? 'granted' : 'pending',
        grantedAt: granted ? dayAt(s.joinOffset + int(7, 14)) : null,
        grantedById: granted ? owner.id : null,
        note: granted && chance(0.3) ? 'Also gave a shaker bottle' : null,
        createdAt: dayAt(s.joinOffset),
      },
    });
  }

  const lockerRows: Prisma.LockerCreateManyInput[] = [
    ...Array.from({ length: 30 }, (_, i) => ({ gymId, number: `A-${i + 1}`, location: "Men's changing room" })),
    ...Array.from({ length: 12 }, (_, i) => ({ gymId, number: `B-${i + 1}`, location: "Ladies' changing room" })),
  ];
  const latest = new Map(allMemberships.filter(m => m.status !== 'superseded').map(m => [m.memberId, m]));
  const men = members.filter(m => m.gender === 'male');
  const women = members.filter(m => m.gender === 'female');
  const take = (pool: Seeded[], n: number, wantExpired: number) => {
    const exp = pool.filter(m => (latest.get(m.id)?.expiryDate ?? today) < today).slice(0, wantExpired);
    const live = pool.filter(m => (latest.get(m.id)?.expiryDate ?? today) >= today).slice(0, n - exp.length);
    return [...live, ...exp];
  };
  take(men, 18, 2).forEach((m, i) => Object.assign(lockerRows[i]!, { memberId: m.id, assignedAt: dayAt(Math.max(m.joinOffset, -DAYS_BACK) + 1) }));
  take(women, 6, 1).forEach((m, i) => Object.assign(lockerRows[30 + i]!, { memberId: m.id, assignedAt: dayAt(Math.max(m.joinOffset, -DAYS_BACK) + 1) }));
  await prisma.locker.createMany({ data: lockerRows });

  const bookings: Prisma.ClassBookingCreateManyInput[] = [];
  const seen = new Set<string>();
  for (let d = -28; d <= 7; d++) {
    const day = dayAt(d, 0);
    for (const sch of schedules.filter(s => s.dayOfWeek === day.getDay())) {
      for (let k = 0; k < int(4, 11); k++) {
        const m = pick(members.filter(x => x.joinOffset <= d));
        const key = `${m.id}|${sch.id}|${d}`;
        if (seen.has(key)) continue;
        seen.add(key);
        bookings.push({ gymId, scheduleId: sch.id, memberId: m.id, bookingDate: day, status: d < 0 ? (chance(0.85) ? 'attended' : 'cancelled') : 'booked', createdAt: addDays(day, -int(1, 3)) });
      }
    }
  }
  await prisma.classBooking.createMany({ data: bookings, skipDuplicates: true });

  console.log(`  ${meas.length} weigh-ins, ${bookings.length} class bookings, ${expenses.length} expenses`);

  // Demo member login for the portal.
  const demo = members.find(m => m.trainerIdx !== null && measured.includes(m)) ?? measured[0]!;
  await prisma.user.create({
    data: {
      gymId, email: 'member@muscle.demo', name: demo.name, role: 'member', memberId: demo.id,
      passwordHash: await bcrypt.hash('Member@123', 10), emailVerifiedAt: new Date(),
    },
  });
  console.log(`  demo member login: member@muscle.demo / Member@123 (${demo.name})`);
};

await main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
