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

const resendKey = process.env.RESEND_API_KEY;

const host = process.env.SMTP_HOST;
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;

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
const from = process.env.MAIL_FROM
  ?? process.env.SMTP_FROM
  ?? (resendKey ? 'onboarding@resend.dev' : user ?? 'no-reply@localhost');

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
      from,
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
    await transporter!.sendMail({ from, ...mail });
    return true;
  } catch (err) {
    // Logged rather than rethrown: the caller's response must not change
    // depending on whether the mail server happened to be reachable.
    console.error(`[mail] failed to send "${mail.subject}" to ${mail.to}:`, err);
    return false;
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
