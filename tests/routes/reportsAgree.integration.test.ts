import { beforeEach, describe, expect, it } from 'vitest';

import prisma from '../../src/db.js';
import { addPlan, api, makeGym, resetDb } from '../helpers.js';

/**
 * Do the screens agree about the same money?
 *
 * The desk registers one member — plan, joining fee, trainer fee — and then the
 * owner reads the day's takings off four different pages: the payments list,
 * the summary, the monthly collection and the dashboard. Each sums payments in
 * its own query, so each could drift from the others without any one of them
 * being obviously wrong. A receipt is a single payment row, so the receipts
 * for the registration have to add up to the same cash figure too.
 */

beforeEach(resetDb);

const thisMonth = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/** Registers one member the way the desk does, and returns everything needed to read it back. */
const registerWithTrainer = async (opts: { ptFeePaid: boolean }) => {
  const owner = await makeGym();
  const plan = await addPlan(owner.gymId, { price: 3000 });
  const trainer = await prisma.trainer.create({
    data: { gymId: owner.gymId, name: 'Bilal', ptFee: 8000 },
  });

  const res = await api().post('/api/members').set('Cookie', owner.cookie).send({
    name: 'Sunny',
    phone: '03001112233',
    planId: plan.id,
    feeAmount: 3000,
    feeMethod: 'cash',
    trainerId: trainer.id,
    ptFeePaid: opts.ptFeePaid,
  });
  expect(res.status).toBe(201);

  const read = async (path: string, query: Record<string, string> = {}) =>
    (await api().get(path).query(query).set('Cookie', owner.cookie)).body;

  return { owner, memberId: res.body.id as string, read };
};

describe('one registration, four reports', () => {
  it('records the gym fee and the trainer fee as two separate payments', async () => {
    const { owner, memberId } = await registerWithTrainer({ ptFeePaid: true });

    const rows = await prisma.payment.findMany({
      where: { gymId: owner.gymId, memberId },
      orderBy: { amount: 'asc' },
    });

    expect(rows.map((r) => Number(r.amount))).toEqual([3000, 8000]);
    expect(rows.every((r) => r.status === 'paid')).toBe(true);
  });

  it('shows the same cash received on every report when the trainer fee was taken', async () => {
    const { read } = await registerWithTrainer({ ptFeePaid: true });

    const list = await read('/api/payments');
    const summary = await read('/api/payments/summary', { months: '1' });
    const monthly = await read('/api/payments/monthly', { month: thisMonth() });
    const dash = await read('/api/dashboard');

    expect(list.collected).toBe(11000);
    expect(summary.grandTotal).toBe(11000);
    expect(summary.thisMonth).toBe(11000);
    expect(monthly.collected).toBe(11000);
    expect(dash.revenue.monthToDate.total).toBe(11000);
    expect(dash.revenue.thisMonth).toBe(11000);
  });

  it('keeps an unpaid trainer fee out of cash received and in outstanding, everywhere', async () => {
    const { read } = await registerWithTrainer({ ptFeePaid: false });

    const list = await read('/api/payments');
    const summary = await read('/api/payments/summary', { months: '1' });
    const monthly = await read('/api/payments/monthly', { month: thisMonth() });
    const dash = await read('/api/dashboard');

    // Received: only the gym fee.
    expect(list.collected).toBe(3000);
    expect(summary.grandTotal).toBe(3000);
    expect(monthly.collected).toBe(3000);
    expect(dash.revenue.monthToDate.total).toBe(3000);
    expect(dash.revenue.thisMonth).toBe(3000);

    // Owed: the trainer's 8000, by the same figure on each page.
    expect(list.outstanding).toBe(8000);
    expect(summary.dueTotal).toBe(8000);
    expect(monthly.outstanding).toBe(8000);
    expect(dash.revenue.dueTotal).toBe(8000);
  });

  it('splits the dashboard month into what each payment was for', async () => {
    const { read } = await registerWithTrainer({ ptFeePaid: true });

    const { revenue: { monthToDate } } = await read('/api/dashboard');

    // Gym fee is a membership payment; the trainer's fee is "other". The parts
    // must add to the total or one of them is being dropped.
    expect(monthToDate.membership).toBe(3000);
    expect(monthToDate.other).toBe(8000);
    expect(monthToDate.membership + monthToDate.supplement + monthToDate.other).toBe(monthToDate.total);
  });

  it('counts a member as settled once the plan price has been paid, and not before', async () => {
    const { read } = await registerWithTrainer({ ptFeePaid: true });

    const dash = await read('/api/dashboard');

    // Plan 3000, gym fee 3000: settled. The trainer's 8000 must not be
    // credited against the plan, or a member who paid nothing towards it would
    // read as paid in full.
    expect(dash.revenue.collection.settled).toBe(1);
    expect(dash.revenue.collection.pending).toBe(0);
    expect(dash.revenue.collection.collected).toBe(3000);
    expect(dash.revenue.collection.expected).toBe(3000);
  });

  it('gives the same total for today as for the month when everything happened today', async () => {
    const { read } = await registerWithTrainer({ ptFeePaid: true });
    const d = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    const day = await read('/api/payments', { from: today, to: today });

    // The daily view is the same list with a date window; if its edges were
    // off, a payment taken this morning would vanish from "today".
    expect(day.collected).toBe(11000);
    expect(day.total).toBe(2);
  });
});
