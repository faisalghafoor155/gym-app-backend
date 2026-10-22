/** @format */

import { toWhatsAppNumber } from './phone.js';
import type { WhatsAppMessage } from './whatsapp.js';

/**
 * Outgoing SMS, used when WhatsApp cannot deliver.
 *
 * Two ways to configure it, both optional — with neither set every send is a
 * no-op and the app behaves exactly as it did before SMS existed:
 *
 *   - Twilio: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`.
 *   - Any HTTP gateway (the Pakistani bulk-SMS providers mostly work this
 *     way): `SMS_GATEWAY_URL`, with `{to}` and `{message}` placeholders that
 *     are filled in URL-encoded, e.g.
 *     `https://api.example.pk/send?key=XXX&to={to}&text={message}`.
 *     `SMS_GATEWAY_METHOD=POST` sends the same query as a form body instead.
 *
 * Read at call time rather than import time, so a test (or an operator
 * restarting with new env) is not stuck with whatever was set first.
 */

const twilio = () => {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  return sid && token && from ? { sid, token, from } : null;
};

const gateway = () => process.env.SMS_GATEWAY_URL || null;

export const smsEnabled = (): boolean => Boolean(twilio() || gateway());

/**
 * The plain-text body for each WhatsApp template, so a fallback SMS says the
 * same thing. Kept short: one SMS segment is 160 characters, and a notice
 * that splits into three costs three.
 */
const BODIES: Record<string, (v: string[]) => string> = {
  membership_expiry: ([member, gym, plan]) =>
    `Dear ${member}, your ${plan} membership at ${gym} expires today. Please renew at the counter.`,
  membership_expiring_soon: ([member, gym, plan, days]) =>
    `Dear ${member}, your ${plan} membership at ${gym} expires in ${days} days. Please renew on time.`,
  member_welcome: ([member, gym, memberNo]) =>
    `Welcome to ${gym}, ${member}! Your member number is ${memberNo}.`,
  payment_receipt: ([member, gym, amount, forWhat, when]) =>
    `${gym}: received ${amount} from ${member} for ${forWhat} on ${when}. Thank you!`,
  dues_reminder: ([member, gym, amount, plan]) =>
    `Dear ${member}, ${amount} is still pending for ${plan} at ${gym}. Kindly clear it at the counter.`,
  birthday_greeting: ([member, gym]) =>
    `Happy Birthday ${member}! Best wishes from everyone at ${gym}.`,
  member_anniversary: ([member, gym, years]) =>
    `Congratulations ${member} on ${years} year(s) with ${gym}! Thank you for training with us.`,
};

/** The SMS text for a templated message, or null for a template with none. */
export const smsTextFor = (msg: Omit<WhatsAppMessage, 'to'>): string | null =>
  BODIES[msg.template]?.(msg.variables) ?? null;

/**
 * Sends one SMS. Never throws, for the same reason `sendWhatsApp` does not:
 * the message announces something that already happened.
 */
export const sendSms = async (rawTo: string, text: string): Promise<boolean> => {
  // The same Pakistani-mobile rules as WhatsApp: a landline cannot take one.
  const digits = toWhatsAppNumber(rawTo);
  if (!digits) return false;
  const to = `+${digits}`;

  try {
    const tw = twilio();
    if (tw) {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${tw.sid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${tw.sid}:${tw.token}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: to, From: tw.from, Body: text }).toString(),
        },
      );
      if (!res.ok) {
        console.error(`[sms] twilio refused (${res.status}): ${await res.text()}`);
        return false;
      }
      return true;
    }

    const template = gateway();
    if (!template) return false;
    const url = template
      // Most local gateways want the number without the plus.
      .replaceAll('{to}', encodeURIComponent(digits))
      .replaceAll('{message}', encodeURIComponent(text));

    const post = (process.env.SMS_GATEWAY_METHOD ?? 'GET').toUpperCase() === 'POST';
    const res = post
      ? await fetch(url.split('?')[0]!, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: url.includes('?') ? url.slice(url.indexOf('?') + 1) : '',
        })
      : await fetch(url);
    if (!res.ok) {
      console.error(`[sms] gateway refused (${res.status}): ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[sms] failed to send:', err);
    return false;
  }
};
