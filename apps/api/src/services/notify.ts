/**
 * Notifications: what to tell whom. Every message lands in the person's bell in
 * the app; when the server has a mail account (and the person hasn't switched it
 * off) it is also emailed, from the outbox, after the change commits.
 */
import type { Config } from '../config.js';
import type { Sql, TxSql } from '../db.js';
import type { Role } from '../types.js';
import { emailEnabled, renderMail } from './mail.js';

type Db = Sql | TxSql;

export interface Message {
  /** e.g. "checkout.issued". */
  kind: string;
  title: string;
  body?: string;
  /** Path inside the app, e.g. /tools/<id>. */
  link?: string;
  /** Same key for the same person = created once, however often a job runs. */
  dedupe?: string;
  email?: {
    lines?: string[];
    facts?: [string, string][];
    action?: string;
    /** Absolute URL for the button, when it isn't the in-app link (e.g. a single-use answer link). */
    url?: string;
  };
}

export class Notifier {
  constructor(private readonly config: Config) {}

  get emailOn() {
    return emailEnabled(this.config);
  }

  url(path: string) {
    return `${this.config.APP_URL.replace(/\/$/, '')}${path}`;
  }

  /** Sends one message to each person (once each). Returns how many new notifications were created. */
  async send(db: Db, userIds: (string | null | undefined)[], m: Message): Promise<number> {
    const ids = [...new Set(userIds.filter((x): x is string => Boolean(x)))];
    if (ids.length === 0) return 0;
    const host = new URL(this.config.APP_URL).host;
    const mail = renderMail(
      {
        title: m.title,
        lines: m.email?.lines ?? (m.body ? [m.body] : []),
        facts: m.email?.facts,
        url: m.email?.url ?? (m.link ? this.url(m.link) : undefined),
        action: m.email?.action,
      },
      `You get this email because you use ToolTrace at ${host}. You can turn emails off under Notifications in the app.`,
    );
    let created = 0;
    for (const id of ids) {
      const [row] = await db<{ id: string | null }[]>`
        SELECT enqueue_notification(${id}, ${m.kind}, ${m.title}, ${m.body ?? ''}, ${m.link ?? null}, ${m.dedupe ?? null},
                                    ${this.emailOn}, ${m.title}, ${mail.text}, ${mail.html}) AS id`;
      if (row?.id) created++;
    }
    return created;
  }

  /** Emails a calibration lab (not a ToolTrace user) its single-use link. Returns false if email is off. */
  async emailLab(db: Db, jobId: string, c: { title: string; lines: string[]; facts: [string, string][]; url: string }) {
    if (!this.emailOn) return false;
    const mail = renderMail(
      { ...c, action: 'Enter the calibration result' },
      'This link works once and only for this tool. You do not need a ToolTrace account.',
    );
    const [row] = await db<{ ok: boolean }[]>`SELECT enqueue_lab_email(${jobId}, ${c.title}, ${mail.text}, ${mail.html}) AS ok`;
    return row?.ok ?? false;
  }

  /** Everyone active with one of these roles, except the people in `except`. */
  async people(db: Db, roles: Role[], except: (string | null | undefined)[] = []): Promise<string[]> {
    const skip = new Set(except.filter((x): x is string => Boolean(x)));
    const rows = await db<{ id: string; role: Role }[]>`SELECT id, role FROM users WHERE is_active ORDER BY created_at`;
    return rows.filter((r) => roles.includes(r.role) && !skip.has(r.id)).map((r) => r.id);
  }

  /** Crib staff: admins and storekeepers. */
  staff(db: Db, except: (string | null | undefined)[] = []) {
    return this.people(db, ['admin', 'storekeeper'], except);
  }
}
