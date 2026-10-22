/** @format */

import { sendWhatsApp, whatsappEnabled, type SendResult, type WhatsAppMessage } from './whatsapp.js';
import { sendSms, smsEnabled, smsTextFor } from './sms.js';

/**
 * A message to a member's phone: WhatsApp first, SMS when WhatsApp cannot
 * deliver it.
 *
 * WhatsApp stays first because it is free and approved templates read
 * better; SMS is the fallback for an install whose Meta onboarding is not
 * done yet, a template Meta refused, or an outage. Only a `failed` WhatsApp
 * send falls back — `skipped` means the number cannot take a message at all,
 * and an SMS would not reach it either.
 *
 * Callers keep logging the attempt under the `whatsapp` channel: the log row
 * is the "this member's phone was messaged today" claim that stops a second
 * run sending again, whichever transport carried it.
 */

/** Whether any phone transport is configured. A function, not a constant, so
 *  it follows `whatsappEnabled` when a test stubs it. */
export const messagingEnabled = (): boolean => whatsappEnabled || smsEnabled();

export const sendMemberMessage = async (msg: WhatsAppMessage): Promise<SendResult> => {
  const wa: SendResult = whatsappEnabled ? await sendWhatsApp(msg) : 'failed';
  if (wa !== 'failed' || !smsEnabled()) return wa;

  const text = smsTextFor(msg);
  if (!text) return wa;
  return (await sendSms(msg.to, text)) ? 'sent' : 'failed';
};
