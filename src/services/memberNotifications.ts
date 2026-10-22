/** @format */

import prisma from '../db.js';
import { canWhatsApp } from './phone.js';
import { planFor, planHasFeature } from './subscription.js';
import { templates } from './whatsapp.js';
import { messagingEnabled, sendMemberMessage } from './messaging.js';

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

/**
 * Whether it is worth building a message for this member at all.
 *
 * Three separate questions, and the order matters only for cost: whether the
 * install can send at all, whether this gym's plan includes WhatsApp, and
 * whether this member can and wants to receive it. The plan check is a query,
 * so it comes after the two that are free.
 *
 * A gym whose tier excludes WhatsApp is not failing to send — it is not
 * sending, the same way an unconfigured install is not. Nothing here reports
 * it: these are fire-and-forget messages announcing something that already
 * succeeded, and a member registering must not fail because of a plan.
 */
const reachable = async (
  gymId: string,
  member: { phone: string | null; whatsappOptOut: boolean },
): Promise<boolean> => {
  if (!messagingEnabled()) return false;
  if (member.whatsappOptOut || !canWhatsApp(member.phone)) return false;
  return planHasFeature(await planFor(gymId), 'whatsapp');
};

/**
 * The date on a receipt, written for a person rather than for a machine.
 *
 * `en-PK` with a spelled-out month, matching how the emailed invoices already
 * write dates — a member who gets both should not see 03/09 in one and
 * 3 September in the other. Spelled out on purpose: 03/09 is the third of
 * September to the gym and the ninth of March to half the internet, and a
 * receipt is exactly the document somebody quotes back months later.
 */
const receiptDate = (date: Date): string =>
  date.toLocaleDateString('en-PK', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

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
    if (!(await reachable(gymId, member))) return;
    await sendMemberMessage({
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
  when: Date = new Date(),
): Promise<void> => {
  try {
    if (!(await reachable(gymId, member))) return;
    await sendMemberMessage({
      to: member.phone!,
      ...templates.paymentReceipt(
        member.name,
        await gymName(gymId),
        amount,
        forWhat,
        receiptDate(when),
      ),
    });
  } catch (err) {
    console.error('[notify] payment receipt failed:', err);
  }
};
