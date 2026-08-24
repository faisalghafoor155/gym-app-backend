/**
 * Checks the mail configuration without going through the app.
 *
 * The forgot-password flow deliberately hides whether a mail was sent: the
 * endpoint answers identically either way so it cannot be used to discover
 * which addresses are registered, and `sendMail` swallows failures so a dead
 * mail server never turns into a 500. Both are right, and together they make a
 * misconfigured transport invisible from the outside — the refusal only ever
 * reaches the server log.
 *
 * So this exists to ask the question directly. It reports what the app would
 * use, then optionally sends a real message:
 *
 *   npx tsx scripts/checkMail.ts                    # config only
 *   npx tsx scripts/checkMail.ts you@gmail.com      # config, then send
 */

import 'dotenv/config';
import nodemailer from 'nodemailer';

const resendKey = process.env.RESEND_API_KEY;
const host = process.env.SMTP_HOST;
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;
const port = Number(process.env.SMTP_PORT ?? 587);

/** Never print a secret — only enough to tell a real value from a placeholder. */
const shape = (v: string | undefined): string =>
  v ? `set (${v.length} chars, starts "${v.slice(0, 4)}")` : 'not set';

const fail = (msg: string): never => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
};

console.log('Mail configuration\n');
console.log(`  RESEND_API_KEY  ${shape(resendKey)}`);
console.log(`  SMTP_HOST       ${host ?? 'not set'}`);
console.log(`  SMTP_PORT       ${port}`);
console.log(`  SMTP_USER       ${user ?? 'not set'}`);
console.log(`  SMTP_PASS       ${shape(pass)}`);
console.log(`  MAIL_FROM       ${process.env.MAIL_FROM ?? 'not set'}`);
console.log(`  SMTP_FROM       ${process.env.SMTP_FROM ?? 'not set'}`);
console.log(`  APP_URL         ${process.env.APP_URL ?? 'not set (reset links default to :8080)'}`);
console.log();

// Mirrors the precedence in services/mail.ts. Worth restating here because a
// leftover Resend key silently outranking SMTP is exactly the confusion this
// script is meant to end.
if (resendKey) {
  console.log('→ Resend would be used; the SMTP settings are ignored.');
  console.log('  Comment out RESEND_API_KEY to fall through to SMTP.\n');
  process.exit(0);
}

if (!host || !user || !pass) {
  fail('SMTP is incomplete — host, user and pass are all required. Mail is disabled, and messages are only logged.');
}

if (/PASTE_YOUR/i.test(user!) || /PASTE_YOUR/i.test(pass!)) {
  fail('SMTP_USER / SMTP_PASS still hold their placeholders. Put your Gmail address and App Password in backend/.env.');
}

// Google's App Passwords are always 16 characters; the UI shows them in four
// groups of four, and pasting them with the spaces is the usual slip.
const passLen = pass!.replace(/\s/g, '').length;
if (passLen !== 16) {
  console.warn(
    `⚠ SMTP_PASS is ${passLen} characters. A Gmail App Password is exactly 16 — ` +
    `an account password will be rejected with "Username and Password not accepted".\n`,
  );
}

const transporter = nodemailer.createTransport({
  host,
  port,
  secure: port === 465,
  auth: { user, pass },
});

console.log(`Connecting to ${host}:${port} …`);

try {
  await transporter.verify();
  console.log('✔ Connected and authenticated.\n');
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`✖ ${msg}\n`);
  if (/Username and Password not accepted|BadCredentials/i.test(msg)) {
    console.error('  Gmail refused the credentials. This is almost always a normal');
    console.error('  account password where a 16-character App Password is required:');
    console.error('  https://myaccount.google.com/apppasswords\n');
  }
  process.exit(1);
}

const to = process.argv[2];
if (!to) {
  console.log('Config is good. Pass an address to send a test message:');
  console.log('  npx tsx scripts/checkMail.ts you@gmail.com\n');
  process.exit(0);
}

const from = process.env.MAIL_FROM ?? process.env.SMTP_FROM ?? user!;

try {
  const info = await transporter.sendMail({
    from,
    to,
    subject: 'GymPro mail test',
    text:
      'If you are reading this, GymPro can send mail.\n\n' +
      'Password resets and staff invites will now arrive by email.',
  });
  console.log(`✔ Sent to ${to} (id ${info.messageId})`);
  console.log('  Not in the inbox within a minute? Check spam.\n');
} catch (err) {
  console.error(`✖ Send failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
