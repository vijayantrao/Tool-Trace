/**
 * Runs data-source work: imports from a database or a file, and keeps copy
 * tables up to date, on demand or on a schedule.
 *
 * Talking to an outside database can be slow, so it never happens inside a
 * ToolTrace write transaction (those hold the audit-trail lock, which would
 * pause every check-out on the floor). The pattern is always:
 *   read what's needed (read-only transaction) -> talk to the outside database
 *   -> apply and record the result (one short write transaction).
 */
import type { Config } from '../../config.js';
import type { Sql, TxSql } from '../../db.js';
import { SecretBox } from '../../lib/secret-box.js';
import { enterAppRole, type ActorContext } from '../../middleware/db.js';
import { DUE_SOON_DAYS } from '../../routes/tools.js';
import {
  connect,
  pickTable,
  SourceError,
  type Connection,
  type ConnectionSettings,
  type DbKind,
  type MirrorRow,
  type TlsMode,
} from './connectors.js';
import { importTools, TOOL_FIELDS, type DateOrder, type FieldKey, type ImportResult, type Mapping, type RawRow } from './import.js';

export interface SourceRecord {
  id: string;
  name: string;
  kind: DbKind;
  mode: 'import' | 'mirror';
  host: string;
  port: number;
  databaseName: string;
  username: string;
  secret: Buffer;
  tls: TlsMode;
  tableName: string | null;
  mapping: { fields?: Mapping; dateOrder?: DateOrder };
  schedule: 'manual' | 'hourly' | 'daily';
  createdBy: string;
}

export interface RunOutcome {
  ok: boolean;
  message: string;
  import?: ImportResult;
  copied?: number;
}

const ROLLBACK = Symbol('dry-run');
export const secretContext = (id: string) => `data_source:${id}`;

export class DataSources {
  readonly box?: SecretBox;

  constructor(
    private readonly sql: Sql,
    private readonly config: Config,
  ) {
    if (config.DATA_SOURCE_KEY) this.box = new SecretBox(config.DATA_SOURCE_KEY);
  }

  /** Database connections need a key for the passwords, and are off on the public demo. */
  get databases(): { enabled: boolean; reason?: string } {
    if (this.config.DEMO_MODE) return { enabled: false, reason: 'Database connections are switched off on the public demo. Excel and CSV imports work.' };
    if (!this.box) return { enabled: false, reason: 'Database connections are off until the server has a DATA_SOURCE_KEY.' };
    return { enabled: true };
  }

  get maxFileRows() {
    return this.config.DEMO_MODE ? 300 : 5000;
  }

  // ----------------------------------------------------------- transactions
  read<T>(actor: ActorContext, fn: (tx: TxSql) => Promise<T>): Promise<T> {
    return this.sql.begin('read only', async (tx) => {
      await enterAppRole(tx, actor, { write: false });
      return fn(tx);
    }) as Promise<T>;
  }

  write<T>(actor: ActorContext, fn: (tx: TxSql) => Promise<T>): Promise<T> {
    return this.sql.begin('read write', async (tx) => {
      await enterAppRole(tx, actor, { write: true });
      return fn(tx);
    }) as Promise<T>;
  }

  /** Runs the real thing, then rolls it all back: exactly what would happen, without it happening. */
  async dryRun<T>(actor: ActorContext, fn: (tx: TxSql) => Promise<T>): Promise<T> {
    let out: T | undefined;
    try {
      await this.write(actor, async (tx) => {
        out = await fn(tx);
        throw ROLLBACK;
      });
    } catch (err) {
      if (err !== ROLLBACK) throw err;
    }
    return out as T;
  }

  open(settings: ConnectionSettings): Promise<Connection> {
    return connect(settings, { allowPrivate: this.config.DATA_SOURCES_ALLOW_PRIVATE });
  }

  settingsOf(s: SourceRecord): ConnectionSettings {
    if (!this.box) throw new SourceError('Database connections are off until the server has a DATA_SOURCE_KEY.');
    let password: string;
    try {
      password = this.box.open(s.secret, secretContext(s.id));
    } catch {
      throw new SourceError('The saved password can no longer be read (the server key changed). Enter the password again.');
    }
    return { kind: s.kind, host: s.host, port: s.port, database: s.databaseName, username: s.username, password, tls: s.tls };
  }

  // ----------------------------------------------------------- reading a source
  /** Rows from a database table, shaped for importTools by the saved mapping. */
  async readMapped(conn: Connection, tableLabel: string, mapping: Mapping): Promise<RawRow[]> {
    const table = pickTable(await conn.listTables(), tableLabel);
    const used = (Object.entries(mapping) as [FieldKey, string][]).filter(([, col]) => col);
    if (!used.some(([f]) => f === 'assetTag') || !used.some(([f]) => f === 'name')) {
      throw new SourceError('Choose the columns for Asset tag and Name.');
    }
    const columns = [...new Set(used.map(([, col]) => col))];
    const rows = await conn.readRows(table, columns, this.config.DEMO_MODE ? 300 : 10_000);
    return rows.map((r, i) => ({
      row: i + 1,
      values: Object.fromEntries(used.map(([f, col]) => [f, r[col]])) as RawRow['values'],
    }));
  }

  // ----------------------------------------------------------- copies
  async mirrorRows(tx: TxSql): Promise<MirrorRow[]> {
    const rows = await tx`
      SELECT t.asset_tag, t.name, t.category, l.name AS location, t.status::text AS status,
             h.display_name AS holder, co.due_back_at, COALESCE(co.due_back_at < now(), false) AS overdue,
             t.requires_calibration, t.calibration_interval_days,
             t.last_calibrated_on::text AS last_calibrated_on, t.calibration_due_on::text AS calibration_due_on,
             CASE WHEN NOT t.requires_calibration THEN 'not_required'
                  WHEN t.calibration_due_on < current_date THEN 'expired'
                  WHEN t.calibration_due_on <= current_date + ${DUE_SOON_DAYS}::int THEN 'due_soon'
                  ELSE 'ok' END AS calibration_state,
             t.rfid_uid
      FROM tools t
      JOIN locations l ON l.id = t.home_location_id
      LEFT JOIN checkouts co ON co.tool_id = t.id AND co.returned_at IS NULL
      LEFT JOIN users h ON h.id = co.holder_id
      ORDER BY t.asset_tag`;
    // The app's connection camel-cases column names; the copy table uses snake_case.
    return rows.map((r) => ({
      asset_tag: r.assetTag, name: r.name, category: r.category, location: r.location, status: r.status,
      holder: r.holder ?? null, due_back_at: r.dueBackAt ?? null, overdue: r.overdue, requires_calibration: r.requiresCalibration,
      calibration_interval_days: r.calibrationIntervalDays ?? null, last_calibrated_on: r.lastCalibratedOn ?? null,
      calibration_due_on: r.calibrationDueOn ?? null, calibration_state: r.calibrationState, rfid_uid: r.rfidUid ?? null,
    }));
  }

  // ----------------------------------------------------------- runs
  async load(actor: ActorContext, id: string): Promise<SourceRecord | undefined> {
    const [s] = await this.read(actor, (tx) => tx<SourceRecord[]>`SELECT * FROM data_sources WHERE id = ${id}`);
    return s;
  }

  /** Imports from, or copies to, a saved database connection, and records how it went. */
  async sync(actor: ActorContext & { userId: string }, source: SourceRecord, opts: { trigger: 'manual' | 'schedule' }): Promise<RunOutcome> {
    let conn: Connection | undefined;
    try {
      conn = await this.open(this.settingsOf(source));
      if (source.mode === 'import') {
        const rows = await this.readMapped(conn, source.tableName!, source.mapping.fields ?? {});
        await conn.close();
        conn = undefined;
        return await this.write(actor, async (tx) => {
          const result = await importTools(tx, rows, {
            sourceLabel: `${source.name} (${source.tableName})`,
            dateOrder: source.mapping.dateOrder ?? 'dmy',
            actorUserId: actor.userId,
          });
          const outcome: RunOutcome = { ok: true, message: describeImport(result), import: result };
          await record(tx, source, actor.userId, opts.trigger, outcome);
          return outcome;
        });
      }
      const rows = await this.read(actor, (tx) => this.mirrorRows(tx));
      await conn.ensureMirrorTable(source.tableName!);
      await conn.replaceMirror(pickTable(await conn.listTables(), source.tableName!), rows);
      const outcome: RunOutcome = { ok: true, message: `Copied ${rows.length} tools to ${source.tableName}`, copied: rows.length };
      await this.write(actor, (tx) => record(tx, source, actor.userId, opts.trigger, outcome));
      return outcome;
    } catch (err) {
      const message = err instanceof SourceError ? err.message : 'Something went wrong while syncing';
      if (!(err instanceof SourceError)) console.error('[data-sources] sync failed', err);
      const outcome: RunOutcome = { ok: false, message };
      await this.write(actor, (tx) => record(tx, source, actor.userId, opts.trigger, outcome)).catch(() => {});
      return outcome;
    } finally {
      await conn?.close();
    }
  }

  /** Runs the scheduled syncs that are due. Several API instances can call this at once safely. */
  async runDue(): Promise<number> {
    if (!this.databases.enabled) return 0;
    // Claim atomically (as the schema owner, outside any app role): each due source goes to one instance only.
    const due = await this.sql<{ id: string; createdBy: string }[]>`
      UPDATE data_sources SET next_sync_at = now() + CASE schedule WHEN 'hourly' THEN interval '1 hour' ELSE interval '1 day' END
      WHERE id IN (
        SELECT id FROM data_sources WHERE schedule <> 'manual' AND next_sync_at <= now()
        ORDER BY next_sync_at LIMIT 5 FOR UPDATE SKIP LOCKED)
      RETURNING id, created_by`;
    for (const d of due) {
      // A schedule acts as the admin who set it up, and stops if they no longer are one.
      const [owner] = await this.sql<{ role: string; isActive: boolean }[]>`SELECT role, is_active FROM users WHERE id = ${d.createdBy}`;
      if (!owner?.isActive || owner.role !== 'admin') {
        await this.sql`
          UPDATE data_sources SET last_sync_at = now(), last_sync_ok = false,
            last_sync_message = 'Paused: the admin who set this up is no longer an admin. Another admin can save it again.',
            next_sync_at = NULL
          WHERE id = ${d.id}`;
        continue;
      }
      const actor = { role: 'admin', userId: d.createdBy, ip: 'schedule' };
      const source = await this.load(actor, d.id);
      if (source) await this.sync(actor, source, { trigger: 'schedule' });
    }
    return due.length;
  }
}

export function describeImport(r: ImportResult): string {
  const parts = [`${r.created} added`, `${r.updated} updated`, `${r.unchanged} unchanged`];
  if (r.skipped) parts.push(`${r.skipped} skipped`);
  return parts.join(', ');
}

export function runSummary(outcome: RunOutcome) {
  const r = outcome.import;
  return r
    ? {
        rows: r.rows, created: r.created, updated: r.updated, unchanged: r.unchanged, skipped: r.skipped,
        calibrationsRecorded: r.calibrationsRecorded, locationsCreated: r.locationsCreated.length,
        problems: r.problems.length, message: outcome.message,
      }
    : { copied: outcome.copied ?? 0, message: outcome.message };
}

async function record(tx: TxSql, s: SourceRecord, userId: string, trigger: 'manual' | 'schedule', outcome: RunOutcome) {
  await tx`
    INSERT INTO data_sync_runs (source_id, source_label, kind, direction, trigger, ok, summary, run_by)
    VALUES (${s.id}, ${s.name}, ${s.kind}, ${s.mode}, ${trigger}, ${outcome.ok}, ${tx.json(runSummary(outcome))}, ${userId})`;
  await tx`
    UPDATE data_sources SET last_sync_at = now(), last_sync_ok = ${outcome.ok}, last_sync_message = ${outcome.message.slice(0, 500)},
      next_sync_at = CASE WHEN schedule = 'manual' THEN NULL
                          ELSE COALESCE(next_sync_at, now() + CASE schedule WHEN 'hourly' THEN interval '1 hour' ELSE interval '1 day' END) END
    WHERE id = ${s.id}`;
}

export { TOOL_FIELDS };
