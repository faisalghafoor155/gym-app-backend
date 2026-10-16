/**
 * Turns off two-factor authentication for an account that is locked out.
 *
 * For an owner or staff member who has lost the authenticator phone and the
 * backup codes. Run by whoever has database access:
 *
 *   npx tsx scripts/resetTwoFactor.ts                  # list accounts with 2FA on
 *   npx tsx scripts/resetTwoFactor.ts <email>          # turn it off for that account
 *
 * The account can then sign in with its password alone and set 2FA up again
 * from the Security page. Every existing session for it is signed out, because
 * a lost phone may still be holding one.
 *
 * No audit row, for the same reason as `suspendGym.ts`: this is an operator at
 * a terminal, not somebody signed in to the gym.
 */

import 'dotenv/config';
import prisma from '../src/db.js';
import { disableTwoFactor } from '../src/services/twoFactor.js';

const listAccounts = async (): Promise<void> => {
  const users = await prisma.user.findMany({
    where: { twoFactorEnabled: true },
    select: { email: true, name: true, role: true, gym: { select: { name: true } } },
    orderBy: { email: 'asc' },
  });
  if (users.length === 0) {
    console.log('No account has two-factor authentication turned on.');
    return;
  }
  for (const u of users) {
    console.log(`${u.email}  ${u.name} (${u.role}) — ${u.gym?.name ?? 'no gym'}`);
  }
};

const reset = async (email: string): Promise<void> => {
  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, email: true, twoFactorEnabled: true },
  });
  if (!user) {
    console.error(`No account with the email ${email}.`);
    process.exitCode = 1;
    return;
  }
  if (!user.twoFactorEnabled) {
    console.log(`${user.email} does not have two-factor authentication turned on. Nothing to do.`);
    return;
  }

  await disableTwoFactor(user.id);
  await prisma.user.update({
    where: { id: user.id },
    data: { tokenVersion: { increment: 1 } },
  });
  console.log(
    `Two-factor authentication is off for ${user.email}. ` +
      'They can sign in with their password and turn it on again from Security.',
  );
};

const [email] = process.argv.slice(2);
(email ? reset(email) : listAccounts())
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
