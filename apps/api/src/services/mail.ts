/**
 * Outgoing email: the transport, the message layout, and the worker that sends
 * the outbox.
 *
 * Emails are never sent inside a request. The request writes a row to
 * email_outbox in its own transaction (via enqueue_notification), so a change
 * that rolls back never sends mail, and a slow mail server never slows the crib.
 * The worker then sends pending rows, retrying with backoff.
 */
import nodemailer from 'nodemailer';
import type { Config } from '../config.js';
import type { Sql } from '../db.js';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(mail: OutgoingMail): Promise<void>;
}

/** Email is on when the server has a mail account and this isn't the public demo. */
export const emailEnabled = (config: Config) => Boolean(config.SMTP_URL && config.MAIL_FROM && !config.DEMO_MODE);

export function createMailer(config: Config): Mailer | null {
  if (!emailEnabled(config)) return null;
  const transport = nodemailer.createTransport(config.SMTP_URL!, {
    // Encrypted connections only (STARTTLS on 587, TLS on 465), with the certificate checked.
    requireTLS: !config.SMTP_URL!.startsWith('smtps://'),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  } as Parameters<typeof nodemailer.createTransport>[1]);
  return {
    async send(m) {
      await transport.sendMail({ from: config.MAIL_FROM, to: m.to, subject: m.subject, text: m.text, html: m.html });
    },
  };
}

// ------------------------------------------------------------------ layout
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export interface MailContent {
  title: string;
  /** Plain paragraphs. */
  lines: string[];
  /** Absolute link for the button. */
  url?: string;
  action?: string;
  /** Optional small table: label, value. */
  facts?: [string, string][];
}

/** A plain, readable email that works in every client (tables, inline styles, no images). */
export function renderMail(c: MailContent, footer: string): { text: string; html: string } {
  const text = [
    c.title,
    '',
    ...c.lines,
    ...(c.facts?.length ? ['', ...c.facts.map(([k, v]) => `${k}: ${v}`)] : []),
    ...(c.url ? ['', `${c.action ?? 'Open in ToolTrace'}: ${c.url}`] : []),
    '',
    '--',
    footer,
  ].join('\n');

  const facts = c.facts?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0;border-collapse:collapse;font-size:14px">${c.facts
        .map(
          ([k, v]) =>
            `<tr><td style="padding:4px 16px 4px 0;color:#5b6660">${esc(k)}</td><td style="padding:4px 0;color:#17201c;font-weight:600">${esc(v)}</td></tr>`,
        )
        .join('')}</table>`
    : '';
  const button = c.url
    ? `<p style="margin:24px 0"><a href="${esc(c.url)}" style="display:inline-block;background:#2f5546;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:6px">${esc(c.action ?? 'Open in ToolTrace')}</a></p>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;background:#eef1ee;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#17201c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d5dcd7;border-radius:10px">
<tr><td style="background:#2f5546;color:#ffffff;padding:14px 24px;border-radius:10px 10px 0 0;font-weight:700;font-size:18px;letter-spacing:.3px">ToolTrace</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 12px;font-size:20px;line-height:1.3">${esc(c.title)}</h1>
${c.lines.map((l) => `<p style="margin:0 0 10px;font-size:15px;line-height:1.5">${esc(l)}</p>`).join('')}
${facts}${button}
</td></tr>
<tr><td style="padding:14px 24px;border-top:1px solid #e3e8e4;font-size:12px;color:#5b6660">${esc(footer)}</td></tr>
</table></td></tr></table></body></html>`;
  return { text, html };
}

// ------------------------------------------------------------------ worker
/** Minutes to wait after the 1st, 2nd... failed attempt. After the last one the email is marked failed. */
const BACKOFF_MINUTES = [1, 5, 30, 120, 720];

/**
 * Sends due emails from the outbox. Each email is leased first (its next attempt is
 * pushed 10 minutes ahead in one atomic UPDATE ... SKIP LOCKED), then sent with no
 * database transaction open, so several API instances never send the same email at
 * once and a slow mail server never holds a database connection.
 */
export async function deliverEmails(sql: Sql, mailer: Mailer | null, limit = 20): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  if (!mailer) return { sent, failed };
  for (let i = 0; i < limit; i++) {
    const [m] = await sql<{ id: string; toAddress: string; subject: string; textBody: string; htmlBody: string; attempts: number }[]>`
      UPDATE email_outbox SET next_attempt_at = now() + interval '10 minutes'
      WHERE id = (
        SELECT id FROM email_outbox WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, to_address, subject, text_body, html_body, attempts`;
    if (!m) break;
    try {
      await mailer.send({ to: m.toAddress, subject: m.subject, text: m.textBody, html: m.htmlBody });
      await sql`UPDATE email_outbox SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = ${m.id}`;
      sent++;
    } catch (err) {
      const attempts = m.attempts + 1;
      const wait = BACKOFF_MINUTES[attempts - 1];
      const error = ((err as Error).message || 'send failed').replace(/\s+/g, ' ').slice(0, 500);
      await sql`
        UPDATE email_outbox SET attempts = ${attempts}, last_error = ${error},
               status = ${wait === undefined ? 'failed' : 'pending'},
               next_attempt_at = now() + make_interval(mins => ${wait ?? 0})
        WHERE id = ${m.id}`;
      failed++;
    }
  }
  return { sent, failed };
}
