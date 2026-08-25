import { beforeEach, describe, expect, it } from 'vitest';

import prisma from '../../src/db.js';
import { addMember, addMembership, addPlan, addUser, api, makeGym, resetDb } from '../helpers.js';

/**
 * Exports, and the one property that matters about them: completeness.
 *
 * A page holds what it has fetched — fifty rows of a report, or one page of a
 * list. An export built from that is silently short, and a short export is
 * worse than none: nothing in the file says it is missing anything, so it gets
 * reconciled against a bank statement and the difference is blamed on the
 * books. So each of these puts more rows in than any page would hold and
 * counts what comes back.
 */

beforeEach(resetDb);

/** The data rows of a CSV, without the header and without the BOM. */
const rowsOf = (body: string): string[] =>
  body.replace(/^﻿/, '').trim().split('\n').slice(1).filter(Boolean);

const headerOf = (body: string): string =>
  body.replace(/^﻿/, '').split('\n')[0];

describe('the CSV itself', () => {
  it('leads with a BOM so Excel reads names as UTF-8', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId, { name: 'Ayesha Khan' });
    await prisma.payment.create({
      data: { gymId: owner.gymId, memberId: member.id, amount: 100, type: 'membership' },
    });

    const res = await api().get('/api/payments/export/csv').set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    // Without it Excel on Windows reads the system codepage and mangles every
    // non-ASCII name, which in a Pakistani gym is most of them.
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
  });

  it('quotes a field containing a comma so the columns do not shift', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    await prisma.payment.create({
      data: {
        gymId: owner.gymId, memberId: member.id, amount: 100, type: 'membership',
        notes: 'paid 2,500 in "cash", short',
      },
    });

    const res = await api().get('/api/payments/export/csv').set('Cookie', owner.cookie);

    // The quote is doubled and the whole field wrapped — anything else and
    // every column after it lands one place to the right.
    expect(res.text).toContain('"paid 2,500 in ""cash"", short"');
    expect(rowsOf(res.text)).toHaveLength(1);
  });
});

describe('exporting a month of collection', () => {
  /** More members than the page holds, each with a payment in the month. */
  const aBusyMonth = async (gymId: string, count: number) => {
    const plan = await addPlan(gymId, { price: 2500 });
    for (let i = 0; i < count; i++) {
      const member = await addMember(gymId, {
        name: `Member ${String(i).padStart(3, '0')}`,
        phone: `0300${String(i).padStart(7, '0')}`,
      });
      const membership = await addMembership(gymId, member.id, { planId: plan.id });
      await prisma.payment.create({
        data: {
          gymId, memberId: member.id, membershipId: membership.id,
          amount: 2500, type: 'membership', status: 'paid',
        },
      });
    }
  };

  const thisMonth = (): string => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  };

  it('covers the whole month, not the page the caller was looking at', async () => {
    const owner = await makeGym();
    await aBusyMonth(owner.gymId, 60);

    // The page caps at 50, which is what makes this worth asserting.
    const page = await api().get('/api/payments/monthly')
      .query({ month: thisMonth(), limit: 50 }).set('Cookie', owner.cookie);
    expect(page.body.data).toHaveLength(50);
    expect(page.body.total).toBe(60);

    const csv = await api().get('/api/payments/monthly/export')
      .query({ month: thisMonth() }).set('Cookie', owner.cookie);

    expect(csv.status).toBe(200);
    expect(rowsOf(csv.text)).toHaveLength(60);
  });

  it('carries the search it was given rather than exporting everybody', async () => {
    const owner = await makeGym();
    await aBusyMonth(owner.gymId, 10);

    const csv = await api().get('/api/payments/monthly/export')
      .query({ month: thisMonth(), search: 'Member 003' }).set('Cookie', owner.cookie);

    // The file has to match what was on screen, or it answers a question
    // nobody asked.
    expect(rowsOf(csv.text)).toHaveLength(1);
    expect(csv.text).toContain('Member 003');
  });

  it('exports the unpaid side as its own sheet', async () => {
    const owner = await makeGym();
    const plan = await addPlan(owner.gymId, { price: 2500 });
    for (let i = 0; i < 3; i++) {
      const member = await addMember(owner.gymId, {
        name: `Owing ${i}`, phone: `0301${String(i).padStart(7, '0')}`,
      });
      await addMembership(owner.gymId, member.id, { planId: plan.id });
    }

    const csv = await api().get('/api/payments/monthly/export')
      .query({ month: thisMonth(), view: 'unpaid' }).set('Cookie', owner.cookie);

    expect(csv.status).toBe(200);
    // A debt has no date, method or receipt, so it gets columns of its own
    // rather than a payments row padded with blanks.
    expect(headerOf(csv.text)).toContain('Shortfall');
    expect(headerOf(csv.text)).not.toContain('Method');
    expect(rowsOf(csv.text)).toHaveLength(3);
  });

  it('never exports another gym\'s month', async () => {
    const owner = await makeGym();
    const other = await makeGym({ gymName: 'Rival Gym' });
    await aBusyMonth(other.gymId, 5);

    const csv = await api().get('/api/payments/monthly/export')
      .query({ month: thisMonth() }).set('Cookie', owner.cookie);

    expect(rowsOf(csv.text)).toHaveLength(0);
  });

  it('refuses staff who may not see the gym\'s collection', async () => {
    const owner = await makeGym();
    const staff = await addUser(owner.gymId, { role: 'staff' });

    const res = await api().get('/api/payments/monthly/export')
      .query({ month: thisMonth() }).set('Cookie', staff.cookie);

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('exporting supplement sales', () => {
  const sellMany = async (gymId: string, count: number) => {
    const supplement = await prisma.supplement.create({
      data: { gymId, name: 'Whey', category: 'protein', price: 1000, stock: 10_000 },
      select: { id: true },
    });
    for (let i = 0; i < count; i++) {
      await prisma.supplementSale.create({
        data: {
          gymId, supplementId: supplement.id, quantity: 1,
          unitPrice: 1000, total: 1000,
        },
      });
    }
  };

  it('covers every sale, not the fifty the report shows', async () => {
    const owner = await makeGym();
    await sellMany(owner.gymId, 60);

    // The report deliberately shows fifty — a list a person can read.
    const report = await api().get('/api/supplements/sales/report').set('Cookie', owner.cookie);
    expect(report.body.recent).toHaveLength(50);

    const csv = await api().get('/api/supplements/sales/export').set('Cookie', owner.cookie);

    expect(csv.status).toBe(200);
    // The file is the whole window. This is the bug the endpoint exists for:
    // ten sales were silently missing from every export before it.
    expect(rowsOf(csv.text)).toHaveLength(60);
  });

  it('names a buyerless sale as a walk-in rather than leaving a blank', async () => {
    const owner = await makeGym();
    await sellMany(owner.gymId, 1);

    const csv = await api().get('/api/supplements/sales/export').set('Cookie', owner.cookie);

    // The money was still taken; a column of empties reads as lost data.
    expect(csv.text).toContain('Walk-in');
  });

  it('names the member who bought, with their number', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId, { name: 'Ahmed Ali' });
    const supplement = await prisma.supplement.create({
      data: { gymId: owner.gymId, name: 'Creatine', category: 'creatine', price: 500, stock: 10 },
      select: { id: true },
    });
    await prisma.supplementSale.create({
      data: {
        gymId: owner.gymId, supplementId: supplement.id, memberId: member.id,
        quantity: 2, unitPrice: 500, total: 1000,
      },
    });

    const csv = await api().get('/api/supplements/sales/export').set('Cookie', owner.cookie);

    expect(csv.text).toContain('Ahmed Ali');
    expect(csv.text).toMatch(/MEM-\d{5}/);
    expect(csv.text).toContain('Creatine');
  });

  it('honours the window it was asked for', async () => {
    const owner = await makeGym();
    const supplement = await prisma.supplement.create({
      data: { gymId: owner.gymId, name: 'Whey', category: 'protein', price: 1000, stock: 100 },
      select: { id: true },
    });
    const old = new Date();
    old.setMonth(old.getMonth() - 8);
    await prisma.supplementSale.create({
      data: {
        gymId: owner.gymId, supplementId: supplement.id, quantity: 1,
        unitPrice: 1000, total: 1000, soldAt: old,
      },
    });
    await prisma.supplementSale.create({
      data: {
        gymId: owner.gymId, supplementId: supplement.id, quantity: 1,
        unitPrice: 1000, total: 1000,
      },
    });

    const short = await api().get('/api/supplements/sales/export')
      .query({ months: 3 }).set('Cookie', owner.cookie);
    const long = await api().get('/api/supplements/sales/export')
      .query({ months: 12 }).set('Cookie', owner.cookie);

    expect(rowsOf(short.text)).toHaveLength(1);
    expect(rowsOf(long.text)).toHaveLength(2);
  });

  it('never exports another gym\'s sales', async () => {
    const owner = await makeGym();
    const other = await makeGym({ gymName: 'Rival Gym' });
    await sellMany(other.gymId, 5);

    const csv = await api().get('/api/supplements/sales/export').set('Cookie', owner.cookie);

    expect(rowsOf(csv.text)).toHaveLength(0);
  });

  it('keeps the takings to the owner', async () => {
    const owner = await makeGym();
    const staff = await addUser(owner.gymId, { role: 'staff' });

    const res = await api().get('/api/supplements/sales/export').set('Cookie', staff.cookie);

    // What the gym earned is not front-desk business, unlike selling itself.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
