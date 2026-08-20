/** @format */

import prisma from '../db.js';
import { canWhatsApp } from './phone.js';
import { sendWhatsApp, templates, whatsappEnabled } from './whatsapp.js';

/**
 * The messages that follow something happening, rather than something being
 * due.
 *
 * Separate from `jobs/expiryReminders` because the guarantees differ. The job
 * runs on a schedule, may run twice, and claims each send in `ReminderLog` to
 * stay idempotent. These fire once from the request that caused them: a member
 * is registered once, a payment is recorded once, and there is no second run
 * to guard against.
 *
 * Every function here is fire-and-forget. They are called with `void` from
 * controllers and swallow their own failures, because the operation they
 * announce has already succeeded and must not be undone — or reported as
 * failed — because Meta was unreachable. A member who does not get their
 * receipt on WhatsApp still has a receipt in the system.
 */

/** Whether it is worth building a message for this member at all. */
const reachable = (member: { phone: string | null; whatsappOptOut: boolean }): boolean =>
  whatsappEnabled && !member.whatsappOptOut && canWhatsApp(member.phone);

/** The gym's name, for the message body. Cheap and cached by Postgres. */
const gymName = async (gymId: string): Promise<string> => {
  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
    select: { name: true },
  });
  return gym?.name ?? '';
};

/**
 * Welcomes somebody just registered, with the member number they will be asked
 * for at the desk.
 *
 * The number is the point. It is generated server-side at registration and the
 * member otherwise leaves with no record of it — this is the copy they keep in
 * their pocket.
 */
export const notifyWelcome = async (
  gymId: string,
  member: { name: string; memberNo: string; phone: string | null; whatsappOptOut: boolean },
): Promise<void> => {
  try {
    if (!reachable(member)) return;
    await sendWhatsApp({
      to: member.phone!,
      ...templates.welcome(member.name, await gymName(gymId), member.memberNo),
    });
  } catch (err) {
    console.error('[notify] welcome failed:', err);
  }
};

/**
 * Sends a receipt for money just taken.
 *
 * In most gyms running this, the WhatsApp message *is* the receipt: nothing is
 * printed, and a member who wants proof of what they paid has only what the
 * front desk told them. `forWhat` is what the payment was for in the member's
 * words — the plan they renewed, or the supplement they bought — rather than
 * the enum the row stores.
 */
export const notifyPaymentReceipt = async (
  gymId: string,
  member: { name: string; phone: string | null; whatsappOptOut: boolean },
  amount: string,
  forWhat: string,
): Promise<void> => {
  try {
    if (!reachable(member)) return;
    await sendWhatsApp({
      to: member.phone!,
      ...templates.paymentReceipt(member.name, await gymName(gymId), amount, forWhat),
    });
  } catch (err) {
    console.error('[notify] payment receipt failed:', err);
  }
};
