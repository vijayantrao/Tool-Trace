/**
 * Connections to outside databases (MySQL, PostgreSQL, SQL Server), behind one
 * small interface: list tables, look at one, read rows, and keep a copy table.
 *
 * Safety rules, for every driver:
 * - The address was resolved and checked by net-guard first, and the socket goes
 *   to that exact address, while TLS still verifies the certificate against the
 *   host name the admin typed.
 * - Table and column names are never taken from the request as-is: they must
 *   match what the server itself listed, and are then quoted.
 * - Short timeouts and row caps, so a slow or huge source can't tie up the API.
 */
import net from 'node:net';
import mssql from 'mssql';
import mysql from 'mysql2/promise';
import postgres from 'postgres';
import { BlockedAddressError, resolveTarget } from '../../lib/net-guard.js';

export type DbKind = 'mysql' | 'postgres' | 'mssql';
export type TlsMode = 'verify' | 'require' | 'off';

export interface ConnectionSettings {
  kind: DbKind;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  tls: TlsMode;
}

export interface TableRef {
  schema: string | null;
  name: string;
  /** How it is shown and stored: "Tools", or "inventory.Tools" outside the default schema. */
  label: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
}

/** One row of the copy table ToolTrace keeps in an outside database. */
export interface MirrorRow {
  asset_tag: string;
  name: string;
  category: string;
  location: string;
  status: string;
  holder: string | null;
  due_back_at: Date | null;
  overdue: boolean;
  requires_calibration: boolean;
  calibration_interval_days: number | null;
  last_calibrated_on: string | null;
  calibration_due_on: string | null;
  calibration_state: string;
  rfid_uid: string | null;
}

export const MIRROR_COLUMNS = [
  'asset_tag', 'name', 'category', 'location', 'status', 'holder', 'due_back_at', 'overdue',
  'requires_calibration', 'calibration_interval_days', 'last_calibrated_on', 'calibration_due_on',
  'calibration_state', 'rfid_uid', 'synced_at',
] as const;

export const DEFAULT_PORTS: Record<DbKind, number> = { mysql: 3306, postgres: 5432, mssql: 1433 };
export const MAX_READ_ROWS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 30_000;

export interface Connection {
  listTables(): Promise<TableRef[]>;
  /** Columns and the first few rows, for mapping. */
  describe(table: TableRef): Promise<{ columns: ColumnInfo[]; rows: Record<string, unknown>[] }>;
  readRows(table: TableRef, columns: string[], limit: number): Promise<Record<string, unknown>[]>;
  /** Creates ToolTrace's copy table if missing. Refuses a same-named table that isn't one. */
  ensureMirrorTable(name: string): Promise<'created' | 'exists'>;
  /** Replaces the copy table's contents in one transaction. */
  replaceMirror(table: TableRef, rows: MirrorRow[]): Promise<void>;
  close(): Promise<void>;
}

/** A message an admin can act on, without driver internals. */
export class SourceError extends Error {}

export function friendlyError(err: unknown, s: { host: string; port: number }): SourceError {
  if (err instanceof SourceError) return err;
  const e = err as { code?: string; message?: string; number?: number };
  const code = e.code ?? '';
  const msg = (e.message ?? '').slice(0, 200);
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg)) return new SourceError(`Nothing is accepting connections at ${s.host}:${s.port}. Check the host and port.`);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /ENOTFOUND/.test(msg)) return new SourceError(`The host name ${s.host} could not be found.`);
  if (['ETIMEDOUT', 'ETIMEOUT', 'ESOCKET'].includes(code) || /timeout|timed out/i.test(msg)) {
    return new SourceError(`${s.host}:${s.port} did not answer in time. Is it reachable from the ToolTrace server (firewall)?`);
  }
  if (/certificate|self[- ]signed|altnames|SSL|TLS/i.test(msg) || code.startsWith('ERR_TLS') || code.includes('CERT')) {
    return new SourceError(`The server's TLS certificate could not be verified (${msg}). If it uses a self-signed certificate, choose "Encrypted, certificate not checked".`);
  }
  if (code === 'ER_ACCESS_DENIED_ERROR' || code === '28P01' || code === 'ELOGIN' || /password authentication|Login failed|Access denied/i.test(msg)) {
    return new SourceError('The database refused the user name or password.');
  }
  if (code === 'ER_BAD_DB_ERROR' || code === '3D000' || /Cannot open database|Unknown database/i.test(msg)) {
    return new SourceError('That database does not exist on the server, or this user cannot open it.');
  }
  return new SourceError(`The database reported: ${msg || code || 'unknown error'}`);
}

export async function connect(s: ConnectionSettings, opts: { allowPrivate: boolean }): Promise<Connection> {
  const address = await resolveTarget(s.host, opts.allowPrivate).catch((err) => {
    throw err instanceof BlockedAddressError ? new SourceError(err.message) : friendlyError(err, s);
  });
  try {
    switch (s.kind) {
      case 'mysql':
        return await connectMysql(s, address);
      case 'postgres':
        return await connectPostgres(s, address);
      case 'mssql':
        return await connectMssql(s, address);
    }
  } catch (err) {
    throw friendlyError(err, s);
  }
}

/** Finds the table the request names among the ones the server listed. */
export function pickTable(tables: TableRef[], label: string): TableRef {
  const t = tables.find((x) => x.label === label);
  if (!t) throw new SourceError(`There is no table called "${label}" that this user can read.`);
  return t;
}

const checkColumns = (available: ColumnInfo[], wanted: string[]) => {
  const names = new Set(available.map((c) => c.name));
  const missing = wanted.filter((c) => !names.has(c));
  if (missing.length) throw new SourceError(`Column ${missing.map((m) => `"${m}"`).join(', ')} is not in that table any more.`);
};

/** The copy table is ToolTrace's if it has ToolTrace's columns. */
const isMirrorShape = (columns: ColumnInfo[]) => {
  const names = new Set(columns.map((c) => c.name.toLowerCase()));
  return MIRROR_COLUMNS.every((c) => names.has(c));
};

const MIRROR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const checkMirrorName = (name: string) => {
  if (!MIRROR_NAME.test(name)) throw new SourceError('Table name: letters, digits and _ only, starting with a letter (max 63).');
};

const mirrorValues = (r: MirrorRow, at: Date) => [
  r.asset_tag, r.name, r.category, r.location, r.status, r.holder, r.due_back_at, r.overdue, r.requires_calibration,
  r.calibration_interval_days, r.last_calibrated_on, r.calibration_due_on, r.calibration_state, r.rfid_uid, at,
];

// ---------------------------------------------------------------- MySQL
async function connectMysql(s: ConnectionSettings, address: string): Promise<Connection> {
  const conn = await mysql.createConnection({
    host: s.host, // used for TLS verification...
    port: s.port,
    stream: () => net.connect({ host: address, port: s.port }), // ...but the socket goes to the checked address
    user: s.username,
    password: s.password,
    database: s.database,
    connectTimeout: CONNECT_TIMEOUT_MS,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
    ssl: s.tls === 'off' ? undefined : { rejectUnauthorized: s.tls === 'verify', verifyIdentity: s.tls === 'verify' },
  });
  const q = (sql: string, values: unknown[] = []) => conn.query({ sql, values, timeout: QUERY_TIMEOUT_MS });
  const id = (name: string) => '`' + name.replace(/`/g, '``') + '`';
  const columnsOf = async (t: TableRef) => {
    const [rows] = await q(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position`,
      [t.name],
    );
    return rows as ColumnInfo[];
  };
  const listTables = async () => {
    const [rows] = await q(
      `SELECT TABLE_NAME AS name FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_type IN ('BASE TABLE', 'VIEW') ORDER BY table_name`,
    );
    return (rows as { name: string }[]).map((r) => ({ schema: null, name: r.name, label: r.name }));
  };
  return {
    listTables,
    async describe(t) {
      const columns = await columnsOf(t);
      const [rows] = await q(`SELECT * FROM ${id(t.name)} LIMIT 5`);
      return { columns, rows: rows as Record<string, unknown>[] };
    },
    async readRows(t, cols, limit) {
      checkColumns(await columnsOf(t), cols);
      const [rows] = await q(`SELECT ${cols.map(id).join(', ')} FROM ${id(t.name)} LIMIT ${Math.min(limit, MAX_READ_ROWS)}`);
      return rows as Record<string, unknown>[];
    },
    async ensureMirrorTable(name) {
      checkMirrorName(name);
      const existing = (await listTables()).find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        if (!isMirrorShape(await columnsOf(existing))) throw new SourceError(`A table called ${name} already exists and was not made by ToolTrace. Choose another name.`);
        return 'exists';
      }
      await q(`CREATE TABLE ${id(name)} (
        asset_tag VARCHAR(32) NOT NULL PRIMARY KEY, name VARCHAR(120) NOT NULL, category VARCHAR(60) NOT NULL,
        location VARCHAR(80) NOT NULL, status VARCHAR(20) NOT NULL, holder VARCHAR(120) NULL,
        due_back_at DATETIME NULL, overdue BOOLEAN NOT NULL, requires_calibration BOOLEAN NOT NULL,
        calibration_interval_days INT NULL, last_calibrated_on DATE NULL, calibration_due_on DATE NULL,
        calibration_state VARCHAR(20) NOT NULL, rfid_uid VARCHAR(40) NULL, synced_at DATETIME NOT NULL
      ) CHARACTER SET utf8mb4`);
      return 'created';
    },
    async replaceMirror(t, rows) {
      const at = new Date();
      await conn.beginTransaction();
      try {
        await q(`DELETE FROM ${id(t.name)}`);
        for (let i = 0; i < rows.length; i += 200) {
          const batch = rows.slice(i, i + 200);
          await q(`INSERT INTO ${id(t.name)} (${MIRROR_COLUMNS.map(id).join(', ')}) VALUES ?`, [batch.map((r) => mirrorValues(r, at))]);
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      }
    },
    close: () => conn.end().catch(() => {}),
  };
}

// ----------------------------------------------------------- PostgreSQL
async function connectPostgres(s: ConnectionSettings, address: string): Promise<Connection> {
  const sql = postgres({
    host: address,
    port: s.port,
    database: s.database,
    username: s.username,
    password: s.password,
    // TLS checks the certificate against the name the admin typed, not the IP we connect to.
    ssl: s.tls === 'off' ? false : { rejectUnauthorized: s.tls === 'verify', servername: s.host },
    max: 1,
    connect_timeout: CONNECT_TIMEOUT_MS / 1000,
    idle_timeout: 5,
    prepare: false,
    onnotice: () => {},
    connection: { statement_timeout: QUERY_TIMEOUT_MS, application_name: 'tooltrace' },
    // Dates stay "YYYY-MM-DD" text instead of becoming midnight-in-some-timezone.
    types: { date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x } },
  });
  const id = (name: string) => '"' + name.replace(/"/g, '""') + '"';
  const ref = (t: TableRef) => (t.schema ? `${id(t.schema)}.${id(t.name)}` : id(t.name));
  const columnsOf = async (t: TableRef) =>
    (await sql`
      SELECT column_name AS name, data_type AS type FROM information_schema.columns
      WHERE table_schema = ${t.schema ?? 'public'} AND table_name = ${t.name} ORDER BY ordinal_position`) as unknown as ColumnInfo[];
  try {
    await sql`SELECT 1`;
  } catch (err) {
    await sql.end({ timeout: 1 }).catch(() => {});
    throw err;
  }
  const listTables = async () => {
    const rows = await sql<{ schema: string; name: string }[]>`
      SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_type IN ('BASE TABLE', 'VIEW')
      ORDER BY table_schema = 'public' DESC, table_schema, table_name`;
    return rows.map((r) => ({ schema: r.schema, name: r.name, label: r.schema === 'public' ? r.name : `${r.schema}.${r.name}` }));
  };
  return {
    listTables,
    async describe(t) {
      const columns = await columnsOf(t);
      const rows = await sql.unsafe(`SELECT * FROM ${ref(t)} LIMIT 5`);
      return { columns, rows: [...rows] as Record<string, unknown>[] };
    },
    async readRows(t, cols, limit) {
      checkColumns(await columnsOf(t), cols);
      const rows = await sql.unsafe(`SELECT ${cols.map(id).join(', ')} FROM ${ref(t)} LIMIT ${Math.min(limit, MAX_READ_ROWS)}`);
      return [...rows] as Record<string, unknown>[];
    },
    async ensureMirrorTable(name) {
      checkMirrorName(name);
      const existing = (await listTables()).find((t) => t.schema === 'public' && t.name === name);
      if (existing) {
        if (!isMirrorShape(await columnsOf(existing))) throw new SourceError(`A table called ${name} already exists and was not made by ToolTrace. Choose another name.`);
        return 'exists';
      }
      await sql.unsafe(`CREATE TABLE ${id(name)} (
        asset_tag varchar(32) PRIMARY KEY, name varchar(120) NOT NULL, category varchar(60) NOT NULL,
        location varchar(80) NOT NULL, status varchar(20) NOT NULL, holder varchar(120),
        due_back_at timestamptz, overdue boolean NOT NULL, requires_calibration boolean NOT NULL,
        calibration_interval_days integer, last_calibrated_on date, calibration_due_on date,
        calibration_state varchar(20) NOT NULL, rfid_uid varchar(40), synced_at timestamptz NOT NULL)`);
      return 'created';
    },
    async replaceMirror(t, rows) {
      const at = new Date();
      await sql.begin(async (tx) => {
        await tx.unsafe(`DELETE FROM ${ref(t)}`);
        for (let i = 0; i < rows.length; i += 200) {
          const batch = rows.slice(i, i + 200);
          const params: unknown[] = [];
          const tuples = batch.map((r) => {
            const v = mirrorValues(r, at);
            const ph = v.map((x) => {
              params.push(x);
              return `$${params.length}`;
            });
            return `(${ph.join(', ')})`;
          });
          await tx.unsafe(`INSERT INTO ${ref(t)} (${MIRROR_COLUMNS.map(id).join(', ')}) VALUES ${tuples.join(', ')}`, params as never[]);
        }
      });
    },
    close: () => sql.end({ timeout: 2 }).catch(() => {}),
  };
}

// ----------------------------------------------------------- SQL Server
async function connectMssql(s: ConnectionSettings, address: string): Promise<Connection> {
  const pool = new mssql.ConnectionPool({
    server: s.host,
    port: s.port,
    database: s.database,
    user: s.username,
    password: s.password,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    requestTimeout: QUERY_TIMEOUT_MS,
    pool: { max: 1, min: 0 },
    options: {
      encrypt: s.tls !== 'off',
      trustServerCertificate: s.tls === 'require',
      // The socket goes to the checked address; the name is still used for TLS and the login.
      connector: async () =>
        new Promise<net.Socket>((resolve, reject) => {
          const sock = net.connect({ host: address, port: s.port });
          sock.once('connect', () => resolve(sock));
          sock.once('error', reject);
        }),
    } as Record<string, unknown>,
  });
  await pool.connect();
  const id = (name: string) => '[' + name.replace(/]/g, ']]') + ']';
  const ref = (t: TableRef) => `${id(t.schema ?? 'dbo')}.${id(t.name)}`;
  const columnsOf = async (t: TableRef) =>
    (
      await pool
        .request()
        .input('schema', mssql.NVarChar, t.schema ?? 'dbo')
        .input('table', mssql.NVarChar, t.name)
        .query(`SELECT COLUMN_NAME AS name, DATA_TYPE AS type FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table ORDER BY ORDINAL_POSITION`)
    ).recordset as ColumnInfo[];
  const listTables = async () => {
    const r = await pool.request().query(`SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW') ORDER BY CASE WHEN TABLE_SCHEMA = 'dbo' THEN 0 ELSE 1 END, TABLE_SCHEMA, TABLE_NAME`);
    return (r.recordset as { schema: string; name: string }[]).map((x) => ({
      schema: x.schema,
      name: x.name,
      label: x.schema === 'dbo' ? x.name : `${x.schema}.${x.name}`,
    }));
  };
  return {
    listTables,
    async describe(t) {
      const columns = await columnsOf(t);
      const rows = (await pool.request().query(`SELECT TOP 5 * FROM ${ref(t)}`)).recordset;
      return { columns, rows: rows as Record<string, unknown>[] };
    },
    async readRows(t, cols, limit) {
      checkColumns(await columnsOf(t), cols);
      const r = await pool.request().query(`SELECT TOP ${Math.min(limit, MAX_READ_ROWS)} ${cols.map(id).join(', ')} FROM ${ref(t)}`);
      return r.recordset as Record<string, unknown>[];
    },
    async ensureMirrorTable(name) {
      checkMirrorName(name);
      const existing = (await listTables()).find((t) => t.schema === 'dbo' && t.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        if (!isMirrorShape(await columnsOf(existing))) throw new SourceError(`A table called ${name} already exists and was not made by ToolTrace. Choose another name.`);
        return 'exists';
      }
      await pool.request().query(`CREATE TABLE dbo.${id(name)} (
        asset_tag NVARCHAR(32) NOT NULL PRIMARY KEY, name NVARCHAR(120) NOT NULL, category NVARCHAR(60) NOT NULL,
        location NVARCHAR(80) NOT NULL, status NVARCHAR(20) NOT NULL, holder NVARCHAR(120) NULL,
        due_back_at DATETIMEOFFSET NULL, overdue BIT NOT NULL, requires_calibration BIT NOT NULL,
        calibration_interval_days INT NULL, last_calibrated_on DATE NULL, calibration_due_on DATE NULL,
        calibration_state NVARCHAR(20) NOT NULL, rfid_uid NVARCHAR(40) NULL, synced_at DATETIMEOFFSET NOT NULL)`);
      return 'created';
    },
    async replaceMirror(t, rows) {
      const at = new Date();
      const tx = new mssql.Transaction(pool);
      await tx.begin();
      try {
        await new mssql.Request(tx).query(`DELETE FROM ${ref(t)}`);
        // SQL Server allows at most 2100 parameters per statement: 15 columns x 100 rows.
        for (let i = 0; i < rows.length; i += 100) {
          const req = new mssql.Request(tx);
          const tuples = rows.slice(i, i + 100).map((r, n) => {
            const v = mirrorValues(r, at);
            return `(${v
              .map((x, k) => {
                const p = `p${n}_${k}`;
                req.input(p, x);
                return `@${p}`;
              })
              .join(', ')})`;
          });
          await req.query(`INSERT INTO ${ref(t)} (${MIRROR_COLUMNS.map(id).join(', ')}) VALUES ${tuples.join(', ')}`);
        }
        await tx.commit();
      } catch (err) {
        await tx.rollback().catch(() => {});
        throw err;
      }
    },
    close: () => pool.close().catch(() => {}),
  };
}
