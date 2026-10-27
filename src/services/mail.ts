import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Outgoing mail, over Resend's HTTP API or plain SMTP.
 *
 * Two transports because they suit different situations: Resend needs one API
 * key and nothing else, while SMTP works with whatever mail account a gym
 * already has. Resend wins when both are set, being the one that needs no
 * ports open.
 *
 * Mail is optional either way. With neither configured the transport is null
 * and every send falls back to logging, so the app runs — and its invite and
 * password-reset flows stay usable — before anyone has set up mail at all.
 */

/**
 * Whether a value is still the placeholder its `.env.example` shipped with.
 *
 * Without this check a half-filled `.env` looks configured, so mail is
 * attempted, refused by the provider, and logged — while the fallback that
 * prints reset links, the thing that keeps the flow usable, stays switched
 * off. Treating a placeholder as absent puts that fallback back.
 *
 * Exported so `scripts/checkMail.ts` reports on the same rule the app applies.
 */
export const isPlaceholder = (value: string): boolean =>
  // Matched anywhere, not just at the start: SMTP_FROM wraps its address in a
  // display name, so the placeholder sits mid-string as `Gym <PASTE_...>`.
  /PASTE_|re_xxx|xxxxx|\byou@|\byourdomain\b|^your /i.test(value.trim());

const real = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && !isPlaceholder(trimmed) ? trimmed : undefined;
};

const resendKey = real(process.env.RESEND_API_KEY);

const host = real(process.env.SMTP_HOST);
const user = real(process.env.SMTP_USER);
const pass = real(process.env.SMTP_PASS);

/** Gmail and most providers speak implicit TLS on 465, STARTTLS on 587. */
const port = Number(process.env.SMTP_PORT ?? 587);

const smtpConfigured = Boolean(host && user && pass);

export const mailEnabled = Boolean(resendKey) || smtpConfigured;

/**
 * Who the mail claims to be from.
 *
 * Resend rejects a From on a domain you have not verified, so it falls back to
 * their onboarding sender, which works with no DNS set up at all. Gmail
 * silently rewrites From to the authenticated account instead — worth knowing
 * when the header looks wrong in testing.
 */
const from = real(process.env.MAIL_FROM)
  ?? real(process.env.SMTP_FROM)
  ?? (resendKey ? 'onboarding@resend.dev' : user ?? 'no-reply@localhost');

/**
 * The From header: always the app's name in front of the configured address.
 *
 * A bare address shows in the inbox as whoever owns the mailbox — the owner's
 * own name, for a gym sending through its Gmail — so a member reading
 * "Faisal" cannot tell a password reset from a personal note. A display name
 * already in MAIL_FROM is replaced for the same reason.
 */
const fromHeader = `"GymPro" <${from.match(/<([^>]+)>/)?.[1] ?? from}>`;

const transporter: Transporter | null = smtpConfigured
  ? nodemailer.createTransport({
      host,
      port,
      // Implicit TLS only on 465; on 587 the connection starts plain and is
      // upgraded, so forcing `secure` there makes it hang instead of fail.
      secure: port === 465,
      auth: { user, pass },
    })
  : null;

/** Resend speaks plain HTTP JSON, so it needs no client library. */
const sendViaResend = async (mail: Mail): Promise<boolean> => {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey!}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromHeader,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
      ...(mail.html && { html: mail.html }),
    }),
  });

  if (!res.ok) {
    // Resend explains refusals in the body — an unverified From or a spent
    // quota reads as a 4xx that would otherwise be a silent nothing.
    console.error(`[mail] Resend refused (${res.status}): ${await res.text()}`);
    return false;
  }
  return true;
};

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Sends a message, or logs it when no transport is configured.
 *
 * Never throws. A password reset that fails to mail must not turn into a 500
 * that tells the caller their address exists — the endpoint answers the same
 * way regardless, and the failure goes to the server log where an operator
 * will see it.
 */
export const sendMail = async (mail: Mail): Promise<boolean> => {
  if (!mailEnabled) {
    // Not an error: the link is the whole point of these messages, so printing
    // it keeps invites and resets working before mail is set up.
    console.log(
      `[mail] No mail transport configured — message not sent.\n` +
      `  to:      ${mail.to}\n` +
      `  subject: ${mail.subject}\n` +
      `${mail.text.split('\n').map(l => `  ${l}`).join('\n')}`,
    );
    return false;
  }

  try {
    if (resendKey) return await sendViaResend(mail);
    await transporter!.sendMail({ from: fromHeader, ...mail });
    return true;
  } catch (err) {
    // Logged rather than rethrown: the caller's response must not change
    // depending on whether the mail server happened to be reachable.
    console.error(`[mail] failed to send "${mail.subject}" to ${mail.to}:`, err);
    return false;
  }
};

/**
 * Whether the configured transport will accept us, without sending anything.
 *
 * `sendMail` swallows failures by design, so a host that blocks SMTP or a
 * revoked app password looks exactly like a mail that was sent. This is the
 * outside check: an error code, never the credentials.
 */
/**
 * Resend has no login to try, so ask it about the key and the sender instead.
 * The refusals this catches — a dead key, an unverified From — are rejected
 * before a message exists, so they never show in Resend's own Emails list.
 */
const verifyResend = async (): Promise<{ ok: boolean; error?: string; note?: string }> => {
  const res = await fetch('https://api.resend.com/domains', {
    headers: { Authorization: `Bearer ${resendKey!}` },
  });
  const body = await res.json().catch(() => ({})) as {
    name?: string;
    data?: { name: string; status: string }[];
  };

  // A sending-only key cannot list domains, but it can send.
  if (res.status === 401 && body.name === 'restricted_api_key') return { ok: true };
  if (!res.ok) return { ok: false, error: `resend: API key rejected (${res.status})` };

  const domain = from.match(/@([^>\s]+)/)?.[1]?.toLowerCase() ?? '';
  if (domain === 'resend.dev') {
    return {
      ok: true,
      note: 'resend: onboarding sender — delivers only to the Resend account\'s own address',
    };
  }
  const verified = body.data?.some(d => d.name.toLowerCase() === domain && d.status === 'verified');
  return verified
    ? { ok: true }
    : { ok: false, error: 'resend: MAIL_FROM domain is not verified in Resend' };
};

export const verifyMail = async (): Promise<{ ok: boolean; error?: string; note?: string }> => {
  if (!mailEnabled) return { ok: false, error: 'not configured' };
  try {
    if (resendKey) return await verifyResend();
    await transporter!.verify();
    return { ok: true };
  } catch (err) {
    const { code, responseCode } = err as { code?: string; responseCode?: number };
    return { ok: false, error: [code, responseCode].filter(Boolean).join(' ') || 'unknown' };
  }
};

/** Shared shell so the two mails look like they came from the same app. */
const layout = (heading: string, body: string, link: string, label: string, footer: string) =>
  `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px">` +
  `<h2 style="margin:0 0 16px;font-size:18px">${heading}</h2>` +
  `${body}` +
  `<p style="margin:24px 0"><a href="${link}" ` +
  `style="background:#2563eb;color:#fff;padding:12px 20px;border-radius:10px;` +
  `text-decoration:none;font-weight:600;display:inline-block">${label}</a></p>` +
  `<p style="color:#6b7280;font-size:13px;line-height:1.5">${footer}</p>` +
  `<p style="color:#9ca3af;font-size:12px;word-break:break-all;margin-top:20px">${link}</p>` +
  `</div>`;

/**
 * Sent when an owner adds a staff member or gives a member a login without
 * choosing a password for them. The recipient sets their own, so the owner
 * never knows it.
 */
export const inviteMail = (
  link: string,
  validHours: number,
  gymName: string,
  role: 'staff' | 'member',
  invitedBy: string,
): Omit<Mail, 'to'> => {
  const what = role === 'staff'
    ? `help run ${gymName}`
    : `see your membership, attendance and payments at ${gymName}`;
  const validity = `${validHours} hour${validHours === 1 ? '' : 's'}`;

  return {
    subject: `You have been added to ${gymName}`,
    text:
      `${invitedBy} has added you to ${gymName} so you can ${what}.\n\n` +
      `Choose a password to activate your account:\n${link}\n\n` +
      `The link is valid for ${validity} and can be used once.\n\n` +
      `If you were not expecting this, you can ignore this email — the account ` +
      `cannot be used until a password is set.`,
    html: layout(
      `You have been added to ${gymName}`,
      `<p style="color:#374151;line-height:1.5"><strong>${invitedBy}</strong> has added ` +
      `you to <strong>${gymName}</strong> so you can ${what}.</p>`,
      link,
      'Choose a password',
      `The link is valid for ${validity} and can be used once. If you were not ` +
      `expecting this, you can ignore this email — the account cannot be used ` +
      `until a password is set.`,
    ),
  };
};

/**
 * Sent to a member on the day their membership runs out.
 *
 * No link and no button, unlike the other two: there is nothing for the member
 * to click. Renewing happens at the counter, so the useful thing this mail can
 * do is tell them plainly what has run out and where to sort it — which is why
 * the gym's own name carries the message rather than a call to action.
 *
 * `planName` is included because a member who has bought more than one thing
 * needs to know which of them expired.
 */
export const membershipExpiryMail = (
  memberName: string,
  gymName: string,
  planName: string,
): Omit<Mail, 'to'> => {
  // Only the first name: the full record often carries a formal name the
  // member is never addressed by out loud.
  const firstName = memberName.split(' ')[0] ?? memberName;

  return {
    subject: `Your ${gymName} membership expires today`,
    text:
      `Hi ${firstName},\n\n` +
      `Your ${planName} membership at ${gymName} expires today.\n\n` +
      `To keep training without a break, renew at the front desk on your next ` +
      `visit.\n\n` +
      `If you have already renewed, please ignore this — it may have crossed ` +
      `with your payment.`,
    html:
      `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px">` +
      `<h2 style="margin:0 0 16px;font-size:18px">Your membership expires today</h2>` +
      `<p style="color:#374151;line-height:1.5">Hi ${firstName},</p>` +
      `<p style="color:#374151;line-height:1.5">Your <strong>${planName}</strong> ` +
      `membership at <strong>${gymName}</strong> expires today.</p>` +
      `<p style="color:#374151;line-height:1.5">To keep training without a break, ` +
      `renew at the front desk on your next visit.</p>` +
      `<p style="color:#6b7280;font-size:13px;line-height:1.5;margin-top:24px">` +
      `If you have already renewed, please ignore this — it may have crossed with ` +
      `your payment.</p>` +
      `</div>`,
  };
};

/** The reset mail itself. Plain text alongside the HTML so it stays readable
 *  in clients that refuse to render markup.
 *
 *  `validMinutes` is passed in rather than hardcoded so the wording cannot
 *  drift away from the TTL the server actually enforces. */
export const passwordResetMail = (
  link: string,
  validMinutes: number,
  gymName?: string,
): Omit<Mail, 'to'> => {
  const who = gymName ?? 'your gym account';
  const validity = `${validMinutes} minute${validMinutes === 1 ? '' : 's'}`;
  return {
    subject: 'Reset your password',
    text:
      `A password reset was requested for ${who}.\n\n` +
      `Open this link to choose a new password:\n${link}\n\n` +
      `The link is valid for ${validity} and can be used once.\n\n` +
      `If you did not request this, you can ignore this email — your password ` +
      `has not changed.`,
    html: layout(
      'Reset your password',
      `<p style="color:#374151;line-height:1.5">A password reset was requested for ` +
      `<strong>${who}</strong>.</p>`,
      link,
      'Choose a new password',
      `The link is valid for ${validity} and can be used once. If you did not ` +
      `request this, you can ignore this email — your password has not changed.`,
    ),
  };
};

/**
 * Sent once, when a gym signs itself up, to check the address was typed
 * correctly.
 *
 * The wording deliberately does not threaten anything. Nothing is withheld
 * from an unverified account and nothing expires if this is ignored, so a mail
 * saying "confirm within 24 hours or else" would be a lie — the only thing the
 * deadline governs is this particular link.
 *
 * What it *does* say is why somebody should care: the address is where a
 * forgotten password goes, and an address with a typo in it is a lockout
 * waiting for the day they need it.
 */
export const verifyEmailMail = (
  link: string,
  validHours: number,
  gymName: string,
  name: string,
): Omit<Mail, 'to'> => {
  const validity = `${validHours} hour${validHours === 1 ? '' : 's'}`;
  return {
    subject: `Confirm your email for ${gymName}`,
    text:
      `Hello ${name},\n\n` +
      `${gymName} is set up and ready to use — this is only to confirm the ` +
      `address it was registered with.\n\n` +
      `Confirm it here:\n${link}\n\n` +
      `The link is valid for ${validity} and can be used once. You can carry ` +
      `on using the app in the meantime; nothing is waiting on this.\n\n` +
      `It matters because this is the address a password reset is sent to. If ` +
      `it has a typo in it, the day you need that link is the day you find out.\n\n` +
      `If you did not sign up, you can ignore this email.`,
    html: layout(
      `Confirm your email for ${gymName}`,
      `<p style="color:#374151;line-height:1.5">Hello <strong>${name}</strong> — ` +
      `<strong>${gymName}</strong> is set up and ready to use. This is only to ` +
      `confirm the address it was registered with.</p>` +
      `<p style="color:#374151;line-height:1.5">It matters because this is where ` +
      `a password reset is sent. If the address has a typo in it, the day you ` +
      `need that link is the day you find out.</p>`,
      link,
      'Confirm this address',
      `The link is valid for ${validity} and can be used once. You can carry on ` +
      `using the app in the meantime — nothing is waiting on this. If you did ` +
      `not sign up, you can ignore this email.`,
    ),
  };
};

/**
 * Escapes text that is about to be interpolated into an HTML mail.
 *
 * The gym's own name reaches these templates, and an owner types it. Without
 * this, a gym called `<script>…` would have that markup delivered into
 * somebody's inbox — harmless in most clients and not worth finding out.
 *
 * Only the five characters that can end an attribute or open a tag; this is
 * for interpolation into element content, not for building URLs.
 */
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Rupees, written the way a Pakistani invoice writes them. */
const rupees = (amount: number): string => `Rs. ${amount.toLocaleString('en-PK')}`;

/** A date written for a person rather than for a machine. */
const readableDate = (date: Date): string =>
  date.toLocaleDateString('en-PK', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * Chases a gym for an unpaid subscription invoice.
 *
 * One template for the whole schedule rather than four, because only two
 * sentences actually change: how the deadline is described, and how sharp the
 * warning is. Four near-identical templates would be four places to fix a
 * wrong figure.
 *
 * The tone escalates but the facts do not move. Every one of these says the
 * same three things — what is owed, by when, and that nothing is deleted —
 * because a gym owner reading the last notice after ignoring the first two is
 * exactly who most needs the facts rather than the alarm.
 *
 * `daysBefore` is days until the due date; `0` is the day itself, and a
 * negative number means the invoice is already overdue and suspension is what
 * is now approaching.
 */
export const subscriptionInvoiceMail = (
  gymName: string,
  ownerName: string,
  amount: number,
  dueDate: Date,
  daysBefore: number,
  suspendsOn: Date,
  payUrl: string,
): Omit<Mail, 'to'> => {
  const firstName = ownerName.split(' ')[0] ?? ownerName;
  const overdue = daysBefore < 0;

  const deadline = overdue
    ? `was due on ${readableDate(dueDate)}`
    : daysBefore === 0
      ? `is due today`
      : `is due on ${readableDate(dueDate)}`;

  const subject = overdue
    ? `Action needed: ${gymName}'s subscription is overdue`
    : daysBefore === 0
      ? `${gymName}'s subscription payment is due today`
      : `${gymName}'s subscription renews in ${daysBefore} days`;

  // The consequence, said plainly and only once. An owner who has ignored two
  // notices needs the date rather than a stronger adjective — and needs to be
  // told, in the same breath, that paying puts everything back.
  const consequence = overdue
    ? `Access will be paused on ${readableDate(suspendsOn)} if it is not settled. ` +
      `Nothing is deleted when that happens — your members, payments and history ` +
      `all stay exactly as they are, and paying restores access straight away.`
    : `If it is not settled, access is paused on ${readableDate(suspendsOn)}. ` +
      `Nothing would be deleted — paying restores everything immediately.`;

  const g = escapeHtml(gymName);
  const name = escapeHtml(firstName);

  return {
    subject,
    text:
      `Hi ${firstName},\n\n` +
      `Your subscription for ${gymName} — ${rupees(amount)} — ${deadline}.\n\n` +
      `${consequence}\n\n` +
      `You can pay from the Plan & usage page:\n${payUrl}\n\n` +
      `If you have already paid, please ignore this — it may have crossed with ` +
      `your payment.`,
    html:
      `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px">` +
      `<h2 style="margin:0 0 16px;font-size:18px">${escapeHtml(subject)}</h2>` +
      `<p style="color:#374151;line-height:1.5">Hi ${name},</p>` +
      `<p style="color:#374151;line-height:1.5">Your subscription for ` +
      `<strong>${g}</strong> — <strong>${rupees(amount)}</strong> — ${deadline}.</p>` +
      `<p style="color:${overdue ? '#b91c1c' : '#374151'};line-height:1.5">` +
      `${consequence}</p>` +
      `<p style="margin:24px 0"><a href="${payUrl}" ` +
      `style="background:#2563eb;color:#fff;padding:12px 20px;border-radius:10px;` +
      `text-decoration:none;font-weight:600;display:inline-block">Pay now</a></p>` +
      `<p style="color:#6b7280;font-size:13px;line-height:1.5;margin-top:24px">` +
      `If you have already paid, please ignore this — it may have crossed with ` +
      `your payment.</p>` +
      `</div>`,
  };
};
