import { beforeEach, describe, expect, it } from 'vitest';

import prisma from '../../src/db.js';
import { addMember, addUser, api, makeGym, resetDb } from '../helpers.js';

/**
 * The supplement counter: stock in, stock out, and the money either way.
 *
 * The cart has its own tests; this covers the single-item sale beside it, and
 * the stock arithmetic both share. The property that matters most is that the
 * three writes a sale makes — the stock decrement, the sale row and the
 * payment — either all happen or none do. A sale that took the money without
 * moving the stock is worse than one that failed and can be rung up again.
 */

beforeEach(resetDb);

const aSupplement = async (
  gymId: string,
  opts: { name?: string; price?: number | null; stock?: number } = {},
) => {
  const { name = 'Whey Protein', price = 5000, stock = 10 } = opts;
  const row = await prisma.supplement.create({
    data: { gymId, name, category: 'protein', price, stock },
    select: { id: true, name: true },
  });
  return row;
};

describe('stock arriving and being kept', () => {
  it('creates a supplement with its opening stock', async () => {
    const owner = await makeGym();

    const res = await api().post('/api/supplements').set('Cookie', owner.cookie).send({
      name: 'Creatine Mono',
      category: 'creatine',
      price: 3500,
      stock: 25,
    });

    expect(res.status).toBe(201);
    const created = res.body.supplement ?? res.body;
    expect(created.stock).toBe(25);
    // Money crosses as a number, not a Decimal string.
    expect(created.price).toBe(3500);
    expect(typeof created.price).toBe('number');
  });

  it('starts at nothing in stock when none is given', async () => {
    const owner = await makeGym();

    const res = await api().post('/api/supplements').set('Cookie', owner.cookie)
      .send({ name: 'BCAA', category: 'bcaa', price: 2000 });

    expect(res.status).toBe(201);
    expect((res.body.supplement ?? res.body).stock).toBe(0);
  });

  it('adds to the stock already there rather than replacing it', async () => {
    const owner = await makeGym();
    const supp = await aSupplement(owner.gymId, { stock: 10 });

    const res = await api().post(`/api/supplements/${supp.id}/restock`)
      .set('Cookie', owner.cookie).send({ quantity: 15, notes: 'Supplier delivery' });

    expect(res.status).toBe(200);
    const after = await prisma.supplement.findUniqueOrThrow({ where: { id: supp.id } });
    expect(after.stock).toBe(25);
  });

  it('records a restock as an event with a reason, not a silent edit', async () => {
    const owner = await makeGym();
    const supp = await aSupplement(owner.gymId, { stock: 4 });

    await api().post(`/api/supplements/${supp.id}/restock`)
      .set('Cookie', owner.cookie).send({ quantity: 6, notes: 'Monthly order' });

    const entry = await prisma.auditLog.findFirst({
      where: { gymId: owner.gymId, action: 'supplement.restock', entityId: supp.id },
    });
    expect(entry).not.toBeNull();
    expect((entry?.before as { stock?: number })?.stock).toBe(4);
    expect((entry?.after as { stock?: number })?.stock).toBe(10);
  });

  it('refuses a restock of nothing', async () => {
    const owner = await makeGym();
    const supp = await aSupplement(owner.gymId, { stock: 5 });

    const res = await api().post(`/api/supplements/${supp.id}/restock`)
      .set('Cookie', owner.cookie).send({ quantity: 0 });

    expect(res.status).toBe(400);
    const after = await prisma.supplement.findUniqueOrThrow({ where: { id: supp.id } });
    expect(after.stock).toBe(5);
  });

  it('refuses a negative restock, which would be a disguised write-off', async () => {
    const owner = await makeGym();
    const supp = await aSupplement(owner.gymId, { stock: 5 });

    const res = await api().post(`/api/supplements/${supp.id}/restock`)
      .set('Cookie', owner.cookie).send({ quantity: -3 });

    expect(res.status).toBe(400);
    const after = await prisma.supplement.findUniqueOrThrow({ where: { id: supp.id } });
    expect(after.stock).toBe(5);
  });
});

describe('selling across the counter', () => {
  it('takes the stock down and records what was taken', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const supp = await aSupplement(owner.gymId, { price: 5000, stock: 10 });

    const res = await api().post(`/api/supplements/${supp.id}/sell`)
      .set('Cookie', owner.cookie).send({ quantity: 3, memberId: member.id });

    expect(res.status).toBe(201);

    const after = await prisma.supplement.findUniqueOrThrow({ where: { id: supp.id } });
    expect(after.stock).toBe(7);

    const sale = await prisma.supplementSale.findFirstOrThrow({ where: { supplementId: supp.id } });
    expect(sale.quantity).toBe(3);
    expect(Number(sale.unitPrice)).toBe(5000);
    // 3 x 5000, computed on the server from the supplement's own price.
    expect(Number(sale.total)).toBe(15000);
  });

  it('hangs the money off the member who bought it', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const supp = await aSupplement(owner.gymId, { price: 2500, stock: 5 });

    await api().post(`/api/supplements/${supp.id}/sell`)
      .set('Cookie', owner.cookie).send({ quantity: 2, memberId: member.id });

    const payment = await prisma.payment.findFirstOrThrow({ where: { memberId: member.id } });
    expect(Number(payment.amount)).toBe(5000);
    expect(payment.type).toBe('supplement');
    expect(payment.status).toBe('paid');
  });

  it('still records a walk-in sale, with no payment to hang off a member', async () => {
    const owner = await makeGym();
    const supp = await aSupplement(owner.gymId, { price: 1000, stock: 5 });

    const res = await api().post(`/api/supplements/${supp.id}/sell`)
      .set('Cookie', owner.cookie).send({ quantity: 1 });

    expect(res.status).toBe(201);
    // The gym still took the money and the stock still moved; there is simply
    // no member for the books to hang a Payment off.
    const sale = await prisma.supplementSale.findFirstOrThrow({ where: { supplementId: supp.id } });
    expect(sale.memberId).toBeNull();
    expect(await prisma.payment.count()).toBe(0);
    expect((await prisma.supplement.findUniqueOrThrow({ where: { id: supp.id } })).stock).toBe(4);
  });

  it('prices the sale from the supplement, not from the request', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const supp = await aSupplement(owner.gymId, { price: 5000, stock: 5 });

    await api().post(`/api/supplements/${supp.id}/sell`).set('Cookie', owner.cookie)
      // A price the front desk can type is a price the front desk can quietly
      // discount, so the field is ignored entirely.
      .send({ quantity: 1, memberId: member.id, price: 1, unitPrice: 1, total: 1 });

    const sale = await prisma.supplementSale.findFirstOrThrow({ where: { supplementId: supp.id } });
    expect(Number(sale.total)).toBe(5000);
  });

  it('keeps the paisa exact on an awkward price', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const supp = await aSupplement(owner.gymId, { price: 0.1, stock: 100 });

    await api().post(`/api/supplements/${supp.id}/sell`)
      .set('Cookie', owner.cookie).send({ quantity: 3, memberId: member.id });

    const sale = await prisma.supplementSale.findFirstOrThrow({ where: { supplementId: supp.id } });
    // 0.1 * 3 is 0.30000000000000004 in binary floating point.
    expect(sale.total.toString()).toBe('0.3');
  });

  it('refuses to sell something with no price set', async () => {
    const owner = await makeGym();
    const supp = await aSupplement(owner.gymId, { price: null, stock: 10 });

    const res = await api().post(`/api/supplements/${supp.id}/sell`)
      .set('Cookie', owner.cookie).send({ quantity: 1 });

    expect(res.status).toBe(400);
    expect((await prisma.supplement.findUniqueOrThrow({ where: { id: supp.id } })).stock).toBe(10);
  });

  it('will not sell another gym\'s stock', async () => {
    const owner = await makeGym();
    const other = await makeGym({ gymName: 'Rival Gym' });
    const theirs = await aSupplement(other.gymId, { stock: 10 });

    const res = await api().post(`/api/supplements/${theirs.id}/sell`)
      .set('Cookie', owner.cookie).send({ quantity: 1 });

    expect(res.status).toBe(404);
    expect((await prisma.supplement.findUniqueOrThrow({ where: { id: theirs.id } })).stock).toBe(10);
  });

  it('will not sell to another gym\'s member', async () => {
    const owner = await makeGym();
    const other = await makeGym({ gymName: 'Rival Gym' });
    const theirMember = await addMember(other.gymId);
    const supp = await aSupplement(owner.gymId, { stock: 10 });

    const res = await api().post(`/api/supplements/${supp.id}/sell`)
      .set('Cookie', owner.cookie).send({ quantity: 1, memberId: theirMember.id });

    expect(res.status).toBe(404);
    // The refusal must come before the stock moves.
    expect((await prisma.supplement.findUniqueOrThrow({ where: { id: supp.id } })).stock).toBe(10);
  });
});

describe('running out of stock', () => {
  it('refuses to sell more than is on the shelf', async () => {
    const owner = await makeGym();
    const supp = await aSupplement(owner.gymId, { stock: 2 });

    const res = await api().post(`/api/supplements/${supp.id}/sell`)
      .set('Cookie', owner.cookie).send({ quantity: 3 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('2');
    expect((await prisma.supplement.findUniqueOrThrow({ where: { id: supp.id } })).stock).toBe(2);
    expect(await prisma.supplementSale.count()).toBe(0);
  });

  it('says it is out of stock rather than offering zero', async () => {
    const owner = await makeGym();
    const supp = await aSupplement(owner.gymId, { stock: 0 });

    const res = await api().post(`/api/supplements/${supp.id}/sell`)
      .set('Cookie', owner.cookie).send({ quantity: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/out of stock/i);
  });

  it('allows the sale that takes the last one', async () => {
    const owner = await makeGym();
    const supp = await aSupplement(owner.gymId, { stock: 3 });

    const res = await api().post(`/api/supplements/${supp.id}/sell`)
      .set('Cookie', owner.cookie).send({ quantity: 3 });

    expect(res.status).toBe(201);
    expect((await prisma.supplement.findUniqueOrThrow({ where: { id: supp.id } })).stock).toBe(0);
  });

  it('never sells the last tub twice when two tills race for it', async () => {
    const owner = await makeGym();
    const supp = await aSupplement(owner.gymId, { price: 1000, stock: 1 });

    const [a, b] = await Promise.all([
      api().post(`/api/supplements/${supp.id}/sell`).set('Cookie', owner.cookie).send({ quantity: 1 }),
      api().post(`/api/supplements/${supp.id}/sell`).set('Cookie', owner.cookie).send({ quantity: 1 }),
    ]);

    // Exactly one wins. The guarded decrement is what enforces this; the
    // read-then-check above it is only for the error message.
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 400]);
    expect((await prisma.supplement.findUniqueOrThrow({ where: { id: supp.id } })).stock).toBe(0);
    expect(await prisma.supplementSale.count()).toBe(1);
  });

  it('leaves no payment behind when the sale is refused', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const supp = await aSupplement(owner.gymId, { stock: 1 });

    await api().post(`/api/supplements/${supp.id}/sell`)
      .set('Cookie', owner.cookie).send({ quantity: 5, memberId: member.id });

    expect(await prisma.payment.count()).toBe(0);
    expect(await prisma.supplementSale.count()).toBe(0);
  });
});

describe('the shelf itself', () => {
  it('lists only the caller\'s own stock', async () => {
    const owner = await makeGym();
    const other = await makeGym({ gymName: 'Rival Gym' });
    await aSupplement(owner.gymId, { name: 'Mine' });
    await aSupplement(other.gymId, { name: 'Theirs' });

    const res = await api().get('/api/supplements').set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    const names = ((res.body.data ?? res.body) as { name: string }[]).map(s => s.name);
    expect(names).toEqual(['Mine']);
  });

  it('corrects a price without touching the stock', async () => {
    const owner = await makeGym();
    const supp = await aSupplement(owner.gymId, { price: 5000, stock: 8 });

    const res = await api().put(`/api/supplements/${supp.id}`)
      .set('Cookie', owner.cookie).send({ price: 5500 });

    expect(res.status).toBe(200);
    const after = await prisma.supplement.findUniqueOrThrow({ where: { id: supp.id } });
    expect(Number(after.price)).toBe(5500);
    expect(after.stock).toBe(8);
  });

  it('prices already-made sales at what they were sold for, not the new price', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);
    const supp = await aSupplement(owner.gymId, { price: 5000, stock: 10 });

    await api().post(`/api/supplements/${supp.id}/sell`)
      .set('Cookie', owner.cookie).send({ quantity: 1, memberId: member.id });
    await api().put(`/api/supplements/${supp.id}`)
      .set('Cookie', owner.cookie).send({ price: 9999 });

    // The unit price is snapshotted onto the sale, so raising the shelf price
    // cannot rewrite what somebody already paid.
    const sale = await prisma.supplementSale.findFirstOrThrow({ where: { supplementId: supp.id } });
    expect(Number(sale.unitPrice)).toBe(5000);
  });

  it('refuses a negative price', async () => {
    const owner = await makeGym();

    const res = await api().post('/api/supplements').set('Cookie', owner.cookie)
      .send({ name: 'Odd', category: 'protein', price: -100 });

    expect(res.status).toBe(400);
  });

  it('refuses a category it does not stock', async () => {
    const owner = await makeGym();

    const res = await api().post('/api/supplements').set('Cookie', owner.cookie)
      .send({ name: 'Mystery', category: 'not-a-category', price: 100 });

    expect(res.status).toBe(400);
  });

  it('will not update or delete another gym\'s supplement', async () => {
    const owner = await makeGym();
    const other = await makeGym({ gymName: 'Rival Gym' });
    const theirs = await aSupplement(other.gymId, { name: 'Theirs' });

    expect((await api().put(`/api/supplements/${theirs.id}`)
      .set('Cookie', owner.cookie).send({ price: 1 })).status).toBe(404);
    expect((await api().delete(`/api/supplements/${theirs.id}`)
      .set('Cookie', owner.cookie)).status).toBe(404);

    const after = await prisma.supplement.findUniqueOrThrow({ where: { id: theirs.id } });
    expect(after.name).toBe('Theirs');
  });

  it('refuses staff who may not manage the shelf', async () => {
    const owner = await makeGym();
    const supp = await aSupplement(owner.gymId, { stock: 5 });
    const staff = await addUser(owner.gymId, { role: 'staff' });

    const res = await api().post(`/api/supplements/${supp.id}/restock`)
      .set('Cookie', staff.cookie).send({ quantity: 5 });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await prisma.supplement.findUniqueOrThrow({ where: { id: supp.id } })).stock).toBe(5);
  });

  it('keeps the sales report to the owner', async () => {
    const owner = await makeGym();
    const staff = await addUser(owner.gymId, { role: 'staff' });

    expect((await api().get('/api/supplements/sales/report').set('Cookie', owner.cookie)).status).toBe(200);
    // What the gym earned is not front-desk business, unlike selling itself.
    expect((await api().get('/api/supplements/sales/report').set('Cookie', staff.cookie)).status)
      .toBeGreaterThanOrEqual(400);
  });
});
