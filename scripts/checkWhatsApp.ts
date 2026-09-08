/**
 * Checks the WhatsApp configuration without going through the app.
 *
 * Every send in the app is fire-and-forget by design: `sendWhatsApp` never
 * throws, because a notification failing must not fail the payment or the
 * registration it was announcing. That is right, and it is also what makes a
 * broken configuration invisible from the outside — an expired token, an
 * unapproved template and a number outside the test allow-list all end up as
 * one line in a server log nobody is watching.
 *
 * So this asks the question directly. It reports what the app would use, then
 * optionally sends a real message:
 *
 *   npm run check:whatsapp                 # config only
 *   npm run check:whatsapp -- 03001234567  # config, then send
 *   npm run check:whatsapp -- 03001234567 membership_expiring_soon
 *
 * The default template is `member_welcome`: of the four it is the one whose
 * variables are all obviously fake in a test message, so a real member who
 * receives one by mistake is not told their membership is ending.
 */

import 'dotenv/config';

// Imported rather than repeated so this script cannot report a configuration
// the app itself would disagree with — the point is to answer for the app, not
// for a copy of its rules that has drifted.
import { sendWhatsApp, templates, whatsappEnabled } from '../src/services/whatsapp';
import { toWhatsAppNumber } from '../src/services/phone';

/** Never print a secret — only enough to tell a real value from a placeholder. */
const shape = (v: string | undefined): string =>
  v ? `set (${v.length} chars, starts "${v.slice(0, 4)}")` : 'not set';

const fail = (msg: string): never => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
};

const token = process.env.WHATSAPP_TOKEN;
const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
const apiVersion = process.env.WHATSAPP_API_VERSION ?? 'v21.0';
const language = process.env.WHATSAPP_LANGUAGE ?? 'en';

console.log('WhatsApp configuration\n');
console.log(`  WHATSAPP_TOKEN            ${shape(token)}`);
console.log(`  WHATSAPP_PHONE_NUMBER_ID  ${phoneNumberId ?? 'not set'}`);
console.log(`  WHATSAPP_API_VERSION      ${apiVersion}`);
console.log(`  WHATSAPP_LANGUAGE         ${language}`);
console.log();

const to = process.argv[2];

/**
 * The number is checked before the credentials.
 *
 * A number this cannot place is worth reporting even on an install where
 * WhatsApp was never configured: it is a fact about the number rather than
 * about the install, and it is the failure hardest to see otherwise — the app
 * treats an unplaceable number as `skipped`, which is an ordinary state and
 * produces no error anywhere.
 */
if (to) {
  const normalised = toWhatsAppNumber(to);
  if (!normalised) {
    fail(
      `"${to}" is not a number WhatsApp can reach.\n\n` +
      `  Pakistani mobiles are 03xx-xxxxxxx (030 through 036). A landline, a\n` +
      `  half-typed number, or a foreign number without its country code all\n` +
      `  land here. The app skips these silently rather than failing.`,
    );
  }
  console.log(`  Recipient                 ${to} → ${normalised}\n`);
}

if (!whatsappEnabled) {
  fail(
    'WhatsApp is not configured, so every send is logged instead of sent.\n\n' +
    '  Both WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are required. They\n' +
    '  come from Meta: WhatsApp → API Setup. Use a permanent System User\n' +
    '  token — the one shown on first setup expires in 24 hours.\n\n' +
    '  src/services/whatsapp-templates.md has the full walkthrough.',
  );
}

/**
 * Ask Meta about the number before sending anything.
 *
 * A send alone is a poor test: `sendWhatsApp` reports a refusal without saying
 * whether the token, the number id or the template was at fault, and a `sent`
 * only means Meta accepted the request — not that it arrived. Reading the
 * phone number back proves the token and the id agree with each other first,
 * so a later failure can only be about the template or the recipient.
 */
console.log('Checking the number with Meta …');

try {
  const res = await fetch(
    `https://graph.facebook.com/${apiVersion}/${phoneNumberId}` +
      `?fields=display_phone_number,verified_name,quality_rating`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  const body = (await res.json()) as {
    display_phone_number?: string;
    verified_name?: string;
    quality_rating?: string;
    error?: { message?: string; type?: string; code?: number };
  };

  if (!res.ok) {
    console.error(`\n✖ Meta refused (${res.status}): ${body.error?.message ?? JSON.stringify(body)}\n`);

    // The two refusals worth naming, because each has a different fix and
    // Meta's own wording points at neither.
    if (body.error?.code === 190) {
      console.error('  The token is expired or revoked. The one shown on first setup');
      console.error('  lasts 24 hours — a permanent token comes from a System User in');
      console.error('  Meta Business Settings.\n');
    } else if (res.status === 404) {
      console.error('  No phone number with that id. Check WHATSAPP_PHONE_NUMBER_ID');
      console.error('  against WhatsApp → API Setup — it is the *Phone number ID*, not');
      console.error('  the phone number itself.\n');
    }
    process.exit(1);
  }

  console.log('✔ Token and phone number id agree.');
  console.log(`  Sending as                ${body.verified_name ?? '(unnamed)'} <${body.display_phone_number ?? '?'}>`);
  if (body.quality_rating) console.log(`  Quality rating            ${body.quality_rating}`);
  console.log();
} catch (err) {
  fail(`Could not reach Meta: ${err instanceof Error ? err.message : String(err)}`);
}

if (!to) {
  console.log('Config is good. Pass a number to send a test message:');
  console.log('  npm run check:whatsapp -- 03001234567\n');
  process.exit(0);
}

/**
 * The four templates, built with obviously-fake values.
 *
 * Named so a specific one can be tested: each is approved separately in Meta's
 * console, and three working with the fourth still pending is the normal state
 * for a day or two after setup.
 */
const samples = {
  member_welcome: templates.welcome('Test', 'GymPro', 'TEST-001'),
  membership_expiry: templates.membershipExpiry('Test', 'GymPro', 'Monthly'),
  membership_expiring_soon: templates.membershipExpiringSoon('Test', 'GymPro', 'Monthly', '3'),
  payment_receipt: templates.paymentReceipt('Test', 'GymPro', 'Rs 3,000', 'Monthly'),
} as const;

const name = (process.argv[3] ?? 'member_welcome') as keyof typeof samples;

if (!(name in samples)) {
  fail(
    `Unknown template "${name}". One of:\n\n` +
      Object.keys(samples).map(t => `    ${t}`).join('\n'),
  );
}

console.log(`Sending "${name}" to ${to} …`);

const result = await sendWhatsApp({ to, ...samples[name] });

if (result === 'sent') {
  console.log('\n✔ Meta accepted the message.');
  console.log('  It should arrive within a few seconds. If it does not, the number');
  console.log('  is probably outside the test allow-list — an unverified business');
  console.log('  may only message numbers added under API Setup.\n');
  process.exit(0);
}

// `skipped` cannot reach here: the number was placed at the top of the script.
console.error('\n✖ Meta refused the message. The reason is logged above.\n');
console.error(`  Most often the template "${name}" is not approved yet, or was`);
console.error(`  approved under a language other than "${language}". Check WhatsApp`);
console.error('  Manager → Message templates, and see');
console.error('  src/services/whatsapp-templates.md for the exact text each needs.\n');
process.exit(1);
