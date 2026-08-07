import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Outgoing mail, over SMTP.
 *
 * Mail is optional: a gym running this locally, or evaluating it, should not
 * have to configure an SMTP account before the app will start. When the
 * credentials are absent the transport is simply null and every send falls
 * back to logging, which is what the password-reset flow relied on before
 * this existed.
 */

const host = process.env.SMTP_HOST;
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;

/** Gmail and most providers speak implicit TLS on 465, STARTTLS on 587. */
const port = Number(process.env.SMTP_PORT ?? 587);

export const mailEnabled = Boolean(host && user && pass);

/** Who the mail claims to be from. Gmail rewrites this to the authenticated
 *  account anyway, so a mismatched value is silently corrected rather than
 *  bounced — worth knowing when the From looks wrong in testing. */
const from = process.env.SMTP_FROM ?? user ?? 'no-reply@localhost';

const transporter: Transporter | null = mailEnabled
  ? nodemailer.createTransport({
      host,
      port,
      // Implicit TLS only on 465; on 587 the connection starts plain and is
      // upgraded, so forcing `secure` there makes it hang instead of fail.
      secure: port === 465,
      auth: { user, pass },
    })
  : null;

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
  if (!transporter) {
    console.log(
      `[mail] SMTP not configured — message not sent.\n` +
      `  to:      ${mail.to}\n` +
      `  subject: ${mail.subject}\n` +
      `${mail.text.split('\n').map(l => `  ${l}`).join('\n')}`,
    );
    return false;
  }

  try {
    await transporter.sendMail({ from, ...mail });
    return true;
  } catch (err) {
    // Logged rather than rethrown: the caller's response must not change
    // depending on whether the mail server happened to be reachable.
    console.error(`[mail] failed to send "${mail.subject}" to ${mail.to}:`, err);
    return false;
  }
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
    html:
      `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px">` +
      `<h2 style="margin:0 0 16px;font-size:18px">Reset your password</h2>` +
      `<p style="color:#374151;line-height:1.5">A password reset was requested for ` +
      `<strong>${who}</strong>.</p>` +
      `<p style="margin:24px 0"><a href="${link}" ` +
      `style="background:#2563eb;color:#fff;padding:12px 20px;border-radius:10px;` +
      `text-decoration:none;font-weight:600;display:inline-block">Choose a new password</a></p>` +
      `<p style="color:#6b7280;font-size:13px;line-height:1.5">The link is valid for ` +
      `${validity} and can be used once. If you did not request this, you can ignore ` +
      `this email — your password has not changed.</p>` +
      `<p style="color:#9ca3af;font-size:12px;word-break:break-all;margin-top:20px">` +
      `${link}</p>` +
      `</div>`,
  };
};
