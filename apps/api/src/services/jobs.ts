/**
 * Scheduled reminders and summaries. Runs every few minutes on every API
 * instance (and once when the API wakes up). Every message has a dedupe key,
 * so however often this runs, and on however many instances, each reminder is
 * created once.
 *
 *   overdue tools             the holder daily, crib staff once
 *   calibration due / expired crib staff, once per due date (30 days ahead)
 *   calibration lab late      whoever sent it, once
 *   unanswered issue          the person it was issued to, once after a day
 *   low stock                 crib staff, at most once a week per item
 *   weekly summary            crib staff, from Monday 08:00 (plant time)
 *   monthly report            admins and auditors, from the 1st at 08:00
 */
import type { Config } from '../config.js';
import type { Sql } from '../db.js';
import type { Notifier } from './notify.js';

export const CALIBRATION_NOTICE_DAYS = 30;
export const ACK_REMINDER_HOURS = 24;

interface Clock {
  today: string;
  week: string;
  month: string;
  lastMonth: string;
  dow: number;
  hour: number;
}

export class JobRunner {
  constructor(
    private readonly sql: Sql,
    private readonly config: Config,
    private readonly notifier: Notifier,
  ) {}

  private when = (d: Date | string) =>
    new Intl.DateTimeFormat('en-IN', {
      timeZone: this.config.TOOLTRACE_SITE_TZ,
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(d));

  private day = (d: string) =>
    new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(
      new Date(`${d}T00:00:00Z`),
    );

  /** Runs every job; one failing job never stops the others. Returns how many notifications each created. */
  async runDue(): Promise<Record<string, number>> {
    const [clock] = await this.sql<Clock[]>`
      SELECT current_date::text AS today, to_char(now(), 'IYYY-"W"IW') AS week, to_char(now(), 'YYYY-MM') AS month,
             to_char(now() - interval '1 month', 'YYYY-MM') AS last_month,
             extract(isodow FROM now())::int AS dow, extract(hour FROM now())::int AS hour`;
    const jobs: [string, () => Promise<number>][] = [
      ['overdue', () => this.overdue(clock!)],
      ['calibration', () => this.calibration()],
      ['labLate', () => this.labLate()],
      ['ackReminders', () => this.ackReminders()],
      ['lowStock', () => this.lowStock(clock!)],
      ['weekly', () => this.weekly(clock!)],
      ['monthly', () => this.monthly(clock!)],
    ];
    const out: Record<string, number> = {};
    for (const [name, run] of jobs) {
      try {
        out[name] = await run();
      } catch (err) {
        console.error(`[jobs] ${name} failed`, err);
        out[name] = -1;
      }
    }
    return out;
  }

  private async overdue(clock: Clock) {
    const rows = await this.sql<
      { id: string; toolId: string; assetTag: string; name: string; holderId: string; holder: string; dueBackAt: Date }[]
    >`
      SELECT c.id, c.tool_id, t.asset_tag, t.name, c.holder_id, h.display_name AS holder, c.due_back_at
      FROM checkouts c JOIN tools t ON t.id = c.tool_id JOIN users h ON h.id = c.holder_id
      WHERE c.returned_at IS NULL AND c.due_back_at < now()
      ORDER BY c.due_back_at LIMIT 500`;
    let n = 0;
    const staff = rows.length ? await this.notifier.staff(this.sql) : [];
    for (const r of rows) {
      n += await this.notifier.send(this.sql, [r.holderId], {
        kind: 'checkout.overdue',
        title: `Please return ${r.assetTag}: it was due ${this.when(r.dueBackAt)}`,
        body: `${r.name} is overdue. Bring it back to the crib, or ask the storekeeper for more time.`,
        link: `/tools/${r.toolId}`,
        dedupe: `overdue:${r.id}:${clock.today}`,
        email: { facts: [['Tool', `${r.assetTag} ${r.name}`], ['Was due', this.when(r.dueBackAt)]] },
      });
      n += await this.notifier.send(this.sql, staff.filter((s) => s !== r.holderId), {
        kind: 'checkout.overdue_staff',
        title: `${r.assetTag} is overdue with ${r.holder}`,
        body: `${r.name} was due back ${this.when(r.dueBackAt)}.`,
        link: `/tools/${r.toolId}`,
        dedupe: `overdue-staff:${r.id}`,
      });
    }
    return n;
  }

  private async calibration() {
    const rows = await this.sql<{ id: string; assetTag: string; name: string; dueOn: string; expired: boolean; status: string }[]>`
      SELECT id, asset_tag, name, calibration_due_on::text AS due_on, calibration_due_on < current_date AS expired, status::text
      FROM tools
      WHERE requires_calibration AND status::text NOT IN ('retired', 'at_calibration')
        AND calibration_due_on <= current_date + ${CALIBRATION_NOTICE_DAYS}::int
      ORDER BY calibration_due_on LIMIT 500`;
    if (!rows.length) return 0;
    const staff = await this.notifier.staff(this.sql);
    let n = 0;
    for (const t of rows) {
      n += await this.notifier.send(this.sql, staff, t.expired
        ? {
            kind: 'calibration.expired',
            title: `${t.assetTag} is locked: calibration expired ${this.day(t.dueOn)}`,
            body: `${t.name} can't be issued until it is calibrated. Send it to the lab from its page.`,
            link: `/tools/${t.id}`,
            dedupe: `cal-expired:${t.id}:${t.dueOn}`,
            email: { action: 'Send for calibration' },
          }
        : {
            kind: 'calibration.due_soon',
            title: `${t.assetTag} is due for calibration on ${this.day(t.dueOn)}`,
            body: `${t.name} locks itself after that date. Book the lab now so it is back in time.`,
            link: `/tools/${t.id}`,
            dedupe: `cal-due:${t.id}:${t.dueOn}`,
            email: { action: 'Send for calibration' },
          });
    }
    return n;
  }

  private async labLate() {
    const rows = await this.sql<{ id: string; toolId: string; assetTag: string; lab: string; expected: string; sentBy: string }[]>`
      SELECT j.id, j.tool_id, t.asset_tag, j.lab_name AS lab, j.expected_back_on::text AS expected, j.sent_by
      FROM calibration_jobs j JOIN tools t ON t.id = j.tool_id
      WHERE j.status IN ('at_lab', 'calibrated') AND j.expected_back_on < current_date`;
    let n = 0;
    for (const r of rows) {
      n += await this.notifier.send(this.sql, [r.sentBy, ...(await this.notifier.staff(this.sql))], {
        kind: 'calibration.lab_late',
        title: `${r.assetTag} is late back from ${r.lab}`,
        body: `It was expected back on ${this.day(r.expected)}. Chase the lab, or receive it if it is already back.`,
        link: `/tools/${r.toolId}`,
        dedupe: `lab-late:${r.id}`,
      });
    }
    return n;
  }

  private async ackReminders() {
    const rows = await this.sql<{ id: string; userId: string; summary: string }[]>`
      SELECT id, user_id, summary FROM acknowledgements
      WHERE status = 'pending' AND created_at < now() - make_interval(hours => ${ACK_REMINDER_HOURS})`;
    let n = 0;
    for (const r of rows) {
      n += await this.notifier.send(this.sql, [r.userId], {
        kind: 'ack.reminder',
        title: 'Please confirm what you were issued',
        body: `${r.summary}. Confirm you have it, or say if you didn't get it.`,
        link: '/',
        dedupe: `ack-reminder:${r.id}`,
      });
    }
    return n;
  }

  private async lowStock(clock: Clock) {
    const rows = await this.sql<{ id: string; code: string; name: string; quantity: number; reorderLevel: number; unit: string }[]>`
      SELECT id, code, name, quantity, reorder_level, unit FROM stock_items
      WHERE is_active AND reorder_level > 0 AND quantity <= reorder_level`;
    if (!rows.length) return 0;
    const staff = await this.notifier.staff(this.sql);
    let n = 0;
    for (const r of rows) n += await this.notifier.send(this.sql, staff, lowStockMessage(r, clock.week));
    return n;
  }

  private async weekly(clock: Clock) {
    if (clock.dow === 1 && clock.hour < 8) return 0;
    const [s] = await this.sql<
      { out: number; overdue: number; dueSoon: number; expired: number; atLab: number; lowStock: number; requests: number; disputed: number }[]
    >`
      SELECT
        (SELECT count(*)::int FROM checkouts WHERE returned_at IS NULL) AS out,
        (SELECT count(*)::int FROM checkouts WHERE returned_at IS NULL AND due_back_at < now()) AS overdue,
        (SELECT count(*)::int FROM tools WHERE requires_calibration AND status::text <> 'retired'
           AND calibration_due_on BETWEEN current_date AND current_date + ${CALIBRATION_NOTICE_DAYS}::int) AS due_soon,
        (SELECT count(*)::int FROM tools WHERE requires_calibration AND status::text NOT IN ('retired', 'at_calibration')
           AND calibration_due_on < current_date) AS expired,
        (SELECT count(*)::int FROM tools WHERE status::text = 'at_calibration') AS at_lab,
        (SELECT count(*)::int FROM stock_items WHERE is_active AND reorder_level > 0 AND quantity <= reorder_level) AS low_stock,
        (SELECT count(*)::int FROM requests WHERE status IN ('submitted', 'reviewed', 'approved')) AS requests,
        (SELECT count(*)::int FROM acknowledgements WHERE status = 'disputed') AS disputed`;
    const staff = await this.notifier.staff(this.sql);
    return this.notifier.send(this.sql, staff, {
      kind: 'report.weekly',
      title: `This week at the crib: ${s!.out} tools out, ${s!.overdue} overdue`,
      body: [
        `${s!.dueSoon} due for calibration in the next ${CALIBRATION_NOTICE_DAYS} days, ${s!.expired} locked, ${s!.atLab} at the lab.`,
        `${s!.lowStock} stock items to reorder, ${s!.requests} open requests, ${s!.disputed} disputed issues.`,
      ].join(' '),
      link: '/reports',
      dedupe: `weekly:${clock.week}`,
      email: {
        lines: ['Here is where things stand this week.'],
        facts: [
          ['Tools out now', String(s!.out)],
          ['Overdue', String(s!.overdue)],
          [`Calibration due (${CALIBRATION_NOTICE_DAYS} days)`, String(s!.dueSoon)],
          ['Locked: calibration expired', String(s!.expired)],
          ['At the calibration lab', String(s!.atLab)],
          ['Stock items to reorder', String(s!.lowStock)],
          ['Open requests', String(s!.requests)],
          ['Disputed issues', String(s!.disputed)],
        ],
        action: 'Open reports',
      },
    });
  }

  private async monthly(clock: Clock) {
    if (clock.hour < 8 && clock.today.endsWith('-01')) return 0;
    const [s] = await this.sql<
      { checkouts: number; lateReturns: number; calibrations: number; toolsAdded: number; issued: number; requestsApproved: number; value: number }[]
    >`
      WITH m AS (SELECT date_trunc('month', now()) - interval '1 month' AS start, date_trunc('month', now()) AS stop)
      SELECT
        (SELECT count(*)::int FROM checkouts, m WHERE checked_out_at >= m.start AND checked_out_at < m.stop) AS checkouts,
        (SELECT count(*)::int FROM checkouts, m WHERE returned_at >= m.start AND returned_at < m.stop AND returned_at > due_back_at) AS late_returns,
        (SELECT count(*)::int FROM calibration_records, m WHERE created_at >= m.start AND created_at < m.stop) AS calibrations,
        (SELECT count(*)::int FROM tools, m WHERE created_at >= m.start AND created_at < m.stop) AS tools_added,
        (SELECT coalesce(-sum(quantity), 0)::int FROM stock_movements, m WHERE kind = 'issue' AND at >= m.start AND at < m.stop) AS issued,
        (SELECT count(*)::int FROM request_events, m WHERE action = 'approved' AND at >= m.start AND at < m.stop) AS requests_approved,
        (SELECT coalesce(sum(unit_price), 0)::float8 FROM tools WHERE status::text <> 'retired') AS value`;
    const people = await this.notifier.people(this.sql, ['admin', 'auditor']);
    const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: this.config.CURRENCY, maximumFractionDigits: 0 });
    return this.notifier.send(this.sql, people, {
      kind: 'report.monthly',
      title: `Monthly report for ${clock.lastMonth}`,
      body: `${s!.checkouts} check-outs (${s!.lateReturns} returned late), ${s!.calibrations} calibrations, ${s!.toolsAdded} tools added, ${s!.issued} stock items issued, ${s!.requestsApproved} requests approved.`,
      link: '/reports',
      dedupe: `monthly:${clock.lastMonth}`,
      email: {
        lines: [`Last month (${clock.lastMonth}) in numbers. The full report and Excel exports are in ToolTrace.`],
        facts: [
          ['Check-outs', String(s!.checkouts)],
          ['Returned late', String(s!.lateReturns)],
          ['Calibrations recorded', String(s!.calibrations)],
          ['Tools added', String(s!.toolsAdded)],
          ['Stock items issued', String(s!.issued)],
          ['Requests approved', String(s!.requestsApproved)],
          ['Value of tools in service', money.format(s!.value)],
        ],
        action: 'Open reports',
      },
    });
  }
}

/** Shared by the job and the moment an issue takes an item below its reorder level: same key, one message a week. */
export function lowStockMessage(
  r: { id: string; code: string; name: string; quantity: number; reorderLevel: number; unit: string },
  week: string,
) {
  return {
    kind: 'stock.low',
    title: `Reorder ${r.code}: ${r.quantity} ${r.unit} left`,
    body: `${r.name} is at or below its reorder level (${r.reorderLevel} ${r.unit}).`,
    link: `/stock?item=${r.id}`,
    dedupe: `low:${r.id}:${week}`,
  };
}
