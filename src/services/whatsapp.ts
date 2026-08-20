/** @format */

import { toWhatsAppNumber } from './phone.js';

/**
 * Outgoing WhatsApp, over Meta's Cloud API.
 *
 * Optional in the same way mail is: with nothing configured every send falls
 * back to logging, so the app runs and every flow stays usable before anyone
 * has been through Meta's onboarding. That onboarding is not quick — business
 * verification and per-template approval both take days — and nothing here
 * should be blocked on it.
 *
 * Only templates. Meta lets a business send free-form text solely inside a
 * 24-hour window opened by the *member* messaging first, which never happens
 * for a renewal notice. Everything this app sends is therefore a template
 * registered in advance, named here and approved in Meta's console. Sending an
 * unapproved name is rejected, not queued — see `templates.md` for the exact
 * text each one needs.
 */

const token = process.env.WHATSAPP_TOKEN;
const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

/** Meta versions its API in the path and retires old ones on a schedule. */
const apiVersion = process.env.WHATSAPP_API_VERSION ?? 'v21.0';

export const whatsappEnabled = Boolean(token && phoneNumberId);

/**
 * The language a template was approved under.
 *
 * Meta treats this as part of the template's identity: the same name approved
 * as `en` and as `ur` are two templates, and asking for the wrong one is a
 * rejection rather than a fallback. English is the default because that is
 * what most Pakistani gyms write their member-facing copy in, even when the
 * conversation around it happens in Urdu.
 */
const language = process.env.WHATSAPP_LANGUAGE ?? 'en';

export interface WhatsAppMessage {
  /** The member's number, as stored. Converted here, not by the caller. */
  to: string;
  /** A template name already approved in Meta's console. */
  template: string;
  /**
   * The `{{1}}`, `{{2}}` … placeholders, in order.
   *
   * Meta matches these by position, not by name, so the order has to agree
   * with the approved body text. A mismatch is not an error — it produces a
   * message with the member's plan where their name should be.
   */
  variables: string[];
}

/**
 * The result of trying to send.
 *
 * `skipped` is not a failure: a member with no usable number is an ordinary
 * state, not something that went wrong, and a caller counting failures should
 * not count them. It is kept apart from `failed` so an operator reading the
 * job's output can tell "nobody to tell" from "we could not tell them".
 */
export type SendResult = 'sent' | 'skipped' | 'failed';

/**
 * Sends one templated message, or logs it when WhatsApp is not configured.
 *
 * Never throws. These are sent alongside things that matter more — a payment
 * being recorded, a member being registered — and a notification failing must
 * not fail the operation it was announcing.
 */
export const sendWhatsApp = async (msg: WhatsAppMessage): Promise<SendResult> => {
  const to = toWhatsAppNumber(msg.to);
  if (!to) {
    // A landline, a foreign number in a shape this cannot place, or a blank
    // field. Nothing to do, and nothing broken.
    return 'skipped';
  }

  if (!whatsappEnabled) {
    console.log(
      `[whatsapp] Not configured — message not sent.\n` +
      `  to:       ${to}\n` +
      `  template: ${msg.template}\n` +
      `  values:   ${msg.variables.join(' | ')}`,
    );
    return 'failed';
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: msg.template,
            language: { code: language },
            components: msg.variables.length
              ? [{
                  type: 'body',
                  parameters: msg.variables.map(text => ({ type: 'text', text })),
                }]
              : [],
          },
        }),
      },
    );

    if (!res.ok) {
      // Meta explains refusals in the body, and the explanations are the
      // useful part: an unapproved template, an expired token and a number
      // outside the test allow-list all read as a 4xx that would otherwise be
      // a silent nothing.
      console.error(`[whatsapp] refused (${res.status}) for ${msg.template}: ${await res.text()}`);
      return 'failed';
    }

    return 'sent';
  } catch (err) {
    console.error(`[whatsapp] failed to send "${msg.template}" to ${to}:`, err);
    return 'failed';
  }
};

/**
 * The templates this app sends, and what goes in each slot.
 *
 * Named here rather than spelled inline at each call site so that the order of
 * the variables lives next to the name they belong to. Meta matches them by
 * position, and a caller passing the right values in the wrong order produces
 * a message that is wrong but perfectly deliverable.
 */
export const templates = {
  /** Membership runs out today. */
  membershipExpiry: (member: string, gym: string, plan: string): Omit<WhatsAppMessage, 'to'> => ({
    template: 'membership_expiry',
    variables: [member, gym, plan],
  }),

  /** Membership runs out in a few days — sent while renewing is still ahead
   *  of the member rather than behind them. */
  membershipExpiringSoon: (
    member: string, gym: string, plan: string, days: string,
  ): Omit<WhatsAppMessage, 'to'> => ({
    template: 'membership_expiring_soon',
    variables: [member, gym, plan, days],
  }),

  /** Registered just now. Carries the member number, which is the thing they
   *  will be asked for at the desk and have no other copy of. */
  welcome: (member: string, gym: string, memberNo: string): Omit<WhatsAppMessage, 'to'> => ({
    template: 'member_welcome',
    variables: [member, gym, memberNo],
  }),

  /** Money was taken. The member's only receipt, in most gyms. */
  paymentReceipt: (
    member: string, gym: string, amount: string, forWhat: string,
  ): Omit<WhatsAppMessage, 'to'> => ({
    template: 'payment_receipt',
    variables: [member, gym, amount, forWhat],
  }),
} as const;
