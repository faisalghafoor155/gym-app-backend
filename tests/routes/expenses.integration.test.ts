import { beforeEach, describe, expect, it } from 'vitest';
import prisma from '../../src/db.js';
import { addMember, addUser, api, makeGym, resetDb } from '../helpers.js';

/**
 * Expenses, and the profit figure they make possible.
 *
 * Before this module the gym could see what came in but never what was left,
 * so the cases that matter most are the arithmetic ones: what counts as
 * revenue, what does not, and that a due is never mistaken for income.
 */

beforeEach(resetDb);

const addExpense = (
  gymId: string,
  opts: { category?: string; amount?: number; spentOn?: Date; vendor?: string } = {},
) =>
  prisma.expense.create({
    data: {
      gymId,
      category: opts.category ?? 'rent',
      amount: opts.amount ?? 50000,
      spentOn: opts.spentOn ?? new Date(),
      vendor: opts.vendor ?? null,
    },
  });

const addPayment = (
  gymId: string,
  memberId: string,
  opts: { amount?: number; status?: string; type?: 'membership' | 'supplement' | 'other'; on?: Date } = {},
) =>
  prisma.payment.create({
    data: {
      gymId,
      memberId,
      amount: opts.amount ?? 3000,
      status: opts.status ?? 'paid',
      type: opts.type ?? 'membership',
      paymentDate: opts.on ?? new Date(),
      method: 'cash',
    },
  });

describe('Expenses — CRUD', () => {
  it('records an expense and attributes it to whoever entered it', async () => {
    const owner = await makeGym();

    const res = await api()
      .post('/api/expenses')
      .set('Cookie', owner.cookie)
      .send({
        category: 'rent',
        amount: 50000,
        spentOn: '2026-08-01',
        vendor: 'Landlord',
        notes: 'August rent',
      });

    expect(res.status).toBe(201);
    // A number, not a Decimal string — the JSON contract the whole app uses.
    expect(res.body.amount).toBe(50000);
    expect(res.body.recordedBy.id).toBe(owner.userId);
  });

  it('refuses a zero or negative amount', async () => {
    const owner = await makeGym();
    for (const amount of [0, -100]) {
      const res = await api()
        .post('/api/expenses')
        .set('Cookie', owner.cookie)
        .send({ category: 'rent', amount, spentOn: '2026-08-01' });
      expect(res.status, `amount ${amount}`).toBe(400);
    }
  });

  it('refuses an empty category', async () => {
    const owner = await makeGym();
    const res = await api()
      .post('/api/expenses')
      .set('Cookie', owner.cookie)
      .send({ category: '   ', amount: 100, spentOn: '2026-08-01' });
    expect(res.status).toBe(400);
  });

  it('updates an expense and logs what changed', async () => {
    const owner = await makeGym();
    const expense = await addExpense(owner.gymId, { amount: 50000 });

    const res = await api()
      .put(`/api/expenses/${expense.id}`)
      .set('Cookie', owner.cookie)
      .send({ amount: 55000 });

    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(55000);

    const entry = await prisma.auditLog.findFirst({
      where: { gymId: owner.gymId, action: 'expense.update' },
    });
    expect(entry).toBeTruthy();
  });

  it('leaves no audit entry when nothing actually changed', async () => {
    const owner = await makeGym();
    const expense = await addExpense(owner.gymId, { amount: 50000 });

    await api()
      .put(`/api/expenses/${expense.id}`)
      .set('Cookie', owner.cookie)
      .send({ amount: 50000 });

    expect(
      await prisma.auditLog.count({ where: { gymId: owner.gymId, action: 'expense.update' } }),
    ).toBe(0);
  });

  it('applies the same amount rule on update as on create', async () => {
    const owner = await makeGym();
    const expense = await addExpense(owner.gymId);

    // A partial update must not be a way in for a value create would reject.
    const res = await api()
      .put(`/api/expenses/${expense.id}`)
      .set('Cookie', owner.cookie)
      .send({ amount: -5 });
    expect(res.status).toBe(400);
  });

  it('deletes an expense, keeping the whole row in the log', async () => {
    const owner = await makeGym();
    const expense = await addExpense(owner.gymId, { category: 'equipment', vendor: 'Gym Co' });

    const res = await api()
      .delete(`/api/expenses/${expense.id}`)
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(204);
    expect(await prisma.expense.count({ where: { gymId: owner.gymId } })).toBe(0);

    const entry = await prisma.auditLog.findFirst({
      where: { gymId: owner.gymId, action: 'expense.delete' },
    });
    // After a delete the log is the only record of what was there.
    expect((entry?.before as { category?: string })?.category).toBe('equipment');
  });

  it('never touches another gym\'s expenses', async () => {
    const owner = await makeGym();
    const other = await makeGym({ gymName: 'Rival Gym' });
    const theirs = await addExpense(other.gymId);

    expect((await api().put(`/api/expenses/${theirs.id}`).set('Cookie', owner.cookie).send({ amount: 1 })).status).toBe(404);
    expect((await api().delete(`/api/expenses/${theirs.id}`).set('Cookie', owner.cookie)).status).toBe(404);
    expect(await prisma.expense.count({ where: { id: theirs.id } })).toBe(1);
  });
});

describe('Expenses — listing', () => {
  it('totals the whole filtered set, not just the page', async () => {
    const owner = await makeGym();
    for (let i = 0; i < 5; i++) await addExpense(owner.gymId, { amount: 1000 });

    const res = await api()
      .get('/api/expenses?limit=2')
      .set('Cookie', owner.cookie);

    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(5);
    expect(res.body.hasMore).toBe(true);
    // A total that changed as you paged would be useless.
    expect(res.body.totalSpent).toBe(5000);
  });

  it('filters by category and by date range', async () => {
    const owner = await makeGym();
    await addExpense(owner.gymId, { category: 'rent', amount: 50000, spentOn: new Date('2026-08-01') });
    await addExpense(owner.gymId, { category: 'utilities', amount: 8000, spentOn: new Date('2026-08-05') });
    await addExpense(owner.gymId, { category: 'rent', amount: 50000, spentOn: new Date('2026-07-01') });

    const byCategory = await api().get('/api/expenses?category=rent').set('Cookie', owner.cookie);
    expect(byCategory.body.total).toBe(2);

    const byDate = await api()
      .get('/api/expenses?from=2026-08-01&to=2026-08-31')
      .set('Cookie', owner.cookie);
    expect(byDate.body.total).toBe(2);
    expect(byDate.body.totalSpent).toBe(58000);
  });

  it('includes an expense dated the last day of the range', async () => {
    const owner = await makeGym();
    // Mid-afternoon on the closing day — a naive `lte` on midnight drops it.
    await addExpense(owner.gymId, { amount: 900, spentOn: new Date('2026-08-31T15:30:00') });

    const res = await api()
      .get('/api/expenses?from=2026-08-01&to=2026-08-31')
      .set('Cookie', owner.cookie);
    expect(res.body.total).toBe(1);
  });

  it('searches vendor, notes and category', async () => {
    const owner = await makeGym();
    await prisma.expense.create({
      data: { gymId: owner.gymId, category: 'utilities', amount: 8000, spentOn: new Date(), vendor: 'K-Electric' },
    });

    const res = await api().get('/api/expenses?search=electric').set('Cookie', owner.cookie);
    expect(res.body.total).toBe(1);
  });

  it('breaks the filtered total down by category, largest first', async () => {
    const owner = await makeGym();
    await addExpense(owner.gymId, { category: 'rent', amount: 50000 });
    await addExpense(owner.gymId, { category: 'utilities', amount: 8000 });
    await addExpense(owner.gymId, { category: 'utilities', amount: 2000 });

    const res = await api().get('/api/expenses').set('Cookie', owner.cookie);
    expect(res.body.byCategory).toEqual([
      { category: 'rent', total: 50000 },
      { category: 'utilities', total: 10000 },
    ]);
  });

  it('rejects a range that ends before it starts', async () => {
    const owner = await makeGym();
    const res = await api()
      .get('/api/expenses?from=2026-08-31&to=2026-08-01')
      .set('Cookie', owner.cookie);
    expect(res.status).toBe(400);
  });

  it('shows one gym nothing of another\'s', async () => {
    const owner = await makeGym();
    const other = await makeGym({ gymName: 'Rival Gym' });
    await addExpense(other.gymId, { amount: 99999 });

    const res = await api().get('/api/expenses').set('Cookie', owner.cookie);
    expect(res.body.total).toBe(0);
    expect(res.body.totalSpent).toBe(0);
  });
});

describe('Profit report', () => {
  it('reports revenue minus expenses', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await addPayment(owner.gymId, member.id, { amount: 30000 });
    await addExpense(owner.gymId, { amount: 12000 });

    const res = await api().get('/api/expenses/profit').set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body.revenue).toBe(30000);
    expect(res.body.expenses).toBe(12000);
    expect(res.body.profit).toBe(18000);
  });

  it('counts only money actually received', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await addPayment(owner.gymId, member.id, { amount: 30000, status: 'paid' });
    await addPayment(owner.gymId, member.id, { amount: 45000, status: 'due' });

    const res = await api().get('/api/expenses/profit').set('Cookie', owner.cookie);

    // A due is what the gym is owed, not what it has. Counting it would report
    // a profit the bank account does not agree with.
    expect(res.body.revenue).toBe(30000);
    expect(res.body.outstanding).toBe(45000);
    expect(res.body.profit).toBe(30000);
  });

  it('reports a loss as a negative number rather than clamping at zero', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await addPayment(owner.gymId, member.id, { amount: 5000 });
    await addExpense(owner.gymId, { amount: 20000 });

    const res = await api().get('/api/expenses/profit').set('Cookie', owner.cookie);
    expect(res.body.profit).toBe(-15000);
  });

  it('is exact to the paisa', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await addPayment(owner.gymId, member.id, { amount: 0.1 });
    await addPayment(owner.gymId, member.id, { amount: 0.2 });
    await addExpense(owner.gymId, { amount: 0.3 });

    const res = await api().get('/api/expenses/profit').set('Cookie', owner.cookie);
    // 0.1 + 0.2 - 0.3 is where naive float arithmetic gives 5.5e-17.
    expect(res.body.profit).toBe(0);
  });

  it('honours a date window on both sides of the books', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await addPayment(owner.gymId, member.id, { amount: 10000, on: new Date('2026-08-10') });
    await addPayment(owner.gymId, member.id, { amount: 99999, on: new Date('2026-06-10') });
    await addExpense(owner.gymId, { amount: 4000, spentOn: new Date('2026-08-12') });
    await addExpense(owner.gymId, { amount: 88888, spentOn: new Date('2026-06-12') });

    const res = await api()
      .get('/api/expenses/profit?from=2026-08-01&to=2026-08-31')
      .set('Cookie', owner.cookie);

    expect(res.body.revenue).toBe(10000);
    expect(res.body.expenses).toBe(4000);
    expect(res.body.profit).toBe(6000);
  });

  it('breaks both sides down', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await addPayment(owner.gymId, member.id, { amount: 20000, type: 'membership' });
    await addPayment(owner.gymId, member.id, { amount: 3000, type: 'supplement' });
    await addExpense(owner.gymId, { category: 'rent', amount: 50000 });

    const res = await api().get('/api/expenses/profit').set('Cookie', owner.cookie);

    expect(res.body.revenueByType).toEqual(
      expect.arrayContaining([
        { type: 'membership', total: 20000 },
        { type: 'supplement', total: 3000 },
      ]),
    );
    expect(res.body.expensesByCategory).toEqual([{ category: 'rent', total: 50000 }]);
  });

  it('reports zeroes rather than failing for a gym with no books yet', async () => {
    const owner = await makeGym();
    const res = await api().get('/api/expenses/profit').set('Cookie', owner.cookie);
    expect(res.body).toMatchObject({ revenue: 0, expenses: 0, profit: 0, outstanding: 0 });
  });

  it('never counts another gym\'s money', async () => {
    const owner = await makeGym();
    const other = await makeGym({ gymName: 'Rival Gym' });
    const theirMember = await addMember(other.gymId);
    await addPayment(other.gymId, theirMember.id, { amount: 99999 });
    await addExpense(other.gymId, { amount: 88888 });

    const res = await api().get('/api/expenses/profit').set('Cookie', owner.cookie);
    expect(res.body).toMatchObject({ revenue: 0, expenses: 0, profit: 0 });
  });
});

describe('Expenses — who may see them', () => {
  it('lets the owner in', async () => {
    const owner = await makeGym();
    expect((await api().get('/api/expenses').set('Cookie', owner.cookie)).status).toBe(200);
  });

  it('lets a manager and an accountant in', async () => {
    const owner = await makeGym();
    for (const level of ['manager', 'accountant'] as const) {
      const staff = await addUser(owner.gymId, { role: 'staff', staffPermission: level });
      expect(
        (await api().get('/api/expenses').set('Cookie', staff.cookie)).status,
        level,
      ).toBe(200);
    }
  });

  it('keeps the front desk and the stockroom out', async () => {
    const owner = await makeGym();
    // A receptionist who can see what a member paid has no business seeing
    // the rent.
    for (const level of ['receptionist', 'members_manager', 'inventory_manager'] as const) {
      const staff = await addUser(owner.gymId, { role: 'staff', staffPermission: level });
      expect(
        (await api().get('/api/expenses').set('Cookie', staff.cookie)).status,
        level,
      ).toBe(403);
      expect(
        (await api().get('/api/expenses/profit').set('Cookie', staff.cookie)).status,
        `${level} profit`,
      ).toBe(403);
    }
  });

  it('keeps members out entirely', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const account = await addUser(owner.gymId, { role: 'member', memberId: member.id });

    expect((await api().get('/api/expenses').set('Cookie', account.cookie)).status).toBe(403);
    expect(
      (await api()
        .post('/api/expenses')
        .set('Cookie', account.cookie)
        .send({ category: 'rent', amount: 1, spentOn: '2026-08-01' })).status,
    ).toBe(403);
  });

  it('requires a session at all', async () => {
    expect((await api().get('/api/expenses')).status).toBe(401);
  });
});
