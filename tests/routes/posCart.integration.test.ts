import { beforeEach, describe, expect, it } from 'vitest';
import prisma from '../../src/db.js';
import { addMember, api, makeGym, resetDb } from '../helpers.js';

beforeEach(resetDb);

describe('POS Shopping Cart & Products Sale API', () => {
  it('allows staff to checkout a cart containing multiple supplements and records sales & payments', async () => {
    const owner = await makeGym();
    const member = await addMember(owner.gymId);

    // Create supplements
    const supp1 = await prisma.supplement.create({
      data: {
        gymId: owner.gymId,
        name: 'Whey Protein Powder',
        category: 'protein',
        price: 5000,
        stock: 10,
      },
    });

    const supp2 = await prisma.supplement.create({
      data: {
        gymId: owner.gymId,
        name: 'Creatine Monohydrate',
        category: 'creatine',
        price: 3000,
        stock: 5,
      },
    });

    // Checkout the cart
    const checkoutRes = await api()
      .post('/api/supplements/checkout-pos')
      .set('Cookie', owner.cookie)
      .send({
        memberId: member.id,
        paymentMethod: 'cash',
        notes: 'Bulk purchase',
        items: [
          { supplementId: supp1.id, quantity: 2 },
          { supplementId: supp2.id, quantity: 1 },
        ],
      });

    expect(checkoutRes.status).toBe(201);
    expect(checkoutRes.body.success).toBe(true);
    expect(checkoutRes.body.salesCount).toBe(2);

    // Verify stock decremented
    const dbSupp1 = await prisma.supplement.findUnique({ where: { id: supp1.id } });
    const dbSupp2 = await prisma.supplement.findUnique({ where: { id: supp2.id } });
    expect(dbSupp1?.stock).toBe(8); // 10 - 2
    expect(dbSupp2?.stock).toBe(4); // 5 - 1

    // Verify sales exist
    const sales = await prisma.supplementSale.findMany({
      where: { memberId: member.id },
    });
    expect(sales.length).toBe(2);

    // Verify payment records created
    const payments = await prisma.payment.findMany({
      where: { memberId: member.id },
    });
    expect(payments.length).toBe(2); // One payment per sale record (due to 1-to-1 paymentId unique constraint)
  });

  it('fails the entire checkout transaction and rolls back stock updates if any item has insufficient stock', async () => {
    const owner = await makeGym();

    const supp1 = await prisma.supplement.create({
      data: {
        gymId: owner.gymId,
        name: 'Whey Protein Powder',
        category: 'protein',
        price: 5000,
        stock: 5,
      },
    });

    const supp2 = await prisma.supplement.create({
      data: {
        gymId: owner.gymId,
        name: 'Creatine Monohydrate',
        category: 'creatine',
        price: 3000,
        stock: 1,
      },
    });

    // Attempting to buy 2 Whey (stock=5) and 2 Creatine (stock=1, insufficient!)
    const checkoutRes = await api()
      .post('/api/supplements/checkout-pos')
      .set('Cookie', owner.cookie)
      .send({
        paymentMethod: 'card',
        items: [
          { supplementId: supp1.id, quantity: 2 },
          { supplementId: supp2.id, quantity: 2 },
        ],
      });

    expect(checkoutRes.status).toBe(400);
    expect(checkoutRes.body.error).toContain('Insufficient stock');

    // Verify stock was NOT decremented (transaction rolled back)
    const dbSupp1 = await prisma.supplement.findUnique({ where: { id: supp1.id } });
    const dbSupp2 = await prisma.supplement.findUnique({ where: { id: supp2.id } });
    expect(dbSupp1?.stock).toBe(5);
    expect(dbSupp2?.stock).toBe(1);
  });
});
