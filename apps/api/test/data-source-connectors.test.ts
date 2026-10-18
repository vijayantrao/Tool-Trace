/**
 * Real connections to real database servers: PostgreSQL always (the test
 * server itself), MySQL/MariaDB and SQL Server when their URLs are set
 * (CI starts both as services):
 *   TEST_MYSQL_URL=mysql://user:pass@127.0.0.1:3306
 *   TEST_MSSQL_URL=mssql://sa:pass@127.0.0.1:1433
 *   TEST_MYSQL_TLS=require   (MySQL 8 servers, which offer TLS out of the box)
 */
import { randomBytes } from 'node:crypto';
import mssql from 'mssql';
import mysql from 'mysql2/promise';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSources } from '../src/services/data-sources/sync.js';
import { createHarness, isoDay, signUp, type Harness } from './helpers/harness.js';

const KEY = 'c3'.repeat(32);
const PG_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';

interface Server {
  kind: 'postgres' | 'mysql' | 'mssql';
  url: URL;
  /** Runs SQL in the test's source database. */
  exec(sql: string): Promise<Record<string, unknown>[]>;
  drop(): Promise<void>;
}

/** A fresh database on the given server, holding a legacy-looking "Tool Master" table. */
async function sourceDatabase(kind: Server['kind'], raw: string): Promise<Server> {
  const url = new URL(raw);
  const db = `tt_src_${randomBytes(4).toString('hex')}`;
  const legacy = (q: (s: string) => string) => [
    `CREATE TABLE ${q('Tool Master')} (${q('Tool ID')} varchar(20), ${q('Description')} varchar(100), ${q('Type')} varchar(40),
       ${q('Last Cal')} date, ${q('Cal Interval')} int, ${q('Notes')} varchar(200))`,
    `INSERT INTO ${q('Tool Master')} VALUES ('TQ-100', 'Torque Wrench 10-50 Nm', 'Torque', '${isoDay(-30)}', 365, 'Bay 2'),
       ('TQ-101', 'Torque Wrench 40-200 Nm', 'Torque', '${isoDay(-400)}', 365, NULL),
       ('ML-200', 'Multimeter', 'Electrical', NULL, NULL, 'x'),
       ('bad tag!', 'Broken row', 'Misc', NULL, NULL, NULL)`,
    `CREATE TABLE inventory (id int, label varchar(20))`,
  ];
  if (kind === 'postgres') {
    const admin = postgres(raw, { max: 1, onnotice: () => {} });
    // Its own login, so the test can check that exact password never comes back out.
    const password = `Src-${randomBytes(6).toString('hex')}`;
    await admin.unsafe(`CREATE ROLE ${db} LOGIN PASSWORD '${password}'`);
    await admin.unsafe(`CREATE DATABASE ${db} OWNER ${db}`);
    url.pathname = `/${db}`;
    url.username = db;
    url.password = password;
    const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
    for (const s of legacy((n) => `"${n}"`)) await sql.unsafe(s);
    return {
      kind, url,
      exec: async (s) => [...(await sql.unsafe(s))],
      drop: async () => {
        await sql.end();
        await admin.unsafe(`DROP DATABASE ${db} WITH (FORCE)`);
        await admin.unsafe(`DROP ROLE ${db}`);
        await admin.end();
      },
    };
  }
  if (kind === 'mysql') {
    const conn = await mysql.createConnection({
      uri: raw,
      dateStrings: true,
      ...(process.env.TEST_MYSQL_TLS === 'require' ? { ssl: { rejectUnauthorized: false } } : {}),
    });
    await conn.query(`CREATE DATABASE ${db}`);
    await conn.query(`USE ${db}`);
    for (const s of legacy((n) => `\`${n}\``)) await conn.query(s);
    url.pathname = `/${db}`;
    return {
      kind, url,
      exec: async (s) => (await conn.query(s))[0] as Record<string, unknown>[],
      drop: async () => { await conn.query(`DROP DATABASE ${db}`); await conn.end(); },
    };
  }
  const base = { server: url.hostname, port: +url.port || 1433, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), options: { encrypt: true, trustServerCertificate: true } };
  const master = await new mssql.ConnectionPool({ ...base, database: 'master' }).connect();
  await master.request().query(`CREATE DATABASE ${db}`);
  const pool = await new mssql.ConnectionPool({ ...base, database: db }).connect();
  for (const s of legacy((n) => `[${n}]`)) await pool.request().query(s.replace(/\),\s+\(/g, '), ('));
  url.pathname = `/${db}`;
  return {
    kind, url,
    exec: async (s) => (await pool.request().query(s)).recordset as Record<string, unknown>[],
    drop: async () => { await pool.close(); await master.request().query(`ALTER DATABASE ${db} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${db}`); await master.close(); },
  };
}

const servers: [Server['kind'], string | undefined][] = [
  ['postgres', PG_URL],
  ['mysql', process.env.TEST_MYSQL_URL],
  ['mssql', process.env.TEST_MSSQL_URL],
];

for (const [kind, url] of servers) {
  describe.skipIf(!url)(`${kind} data sources`, () => {
    let h: Harness;
    let admin: Awaited<ReturnType<typeof signUp>>;
    let src: Server;
    const connection = (over: Record<string, unknown> = {}) => ({
      kind,
      host: src.url.hostname,
      port: +src.url.port || undefined,
      database: src.url.pathname.slice(1),
      username: decodeURIComponent(src.url.username),
      password: decodeURIComponent(src.url.password),
      tls: kind === 'mssql' ? 'require' : kind === 'mysql' ? (process.env.TEST_MYSQL_TLS ?? 'off') : 'off',
      ...over,
    });

    beforeAll(async () => {
      src = await sourceDatabase(kind, url!);
      h = await createHarness({ DATA_SOURCE_KEY: KEY, DATA_SOURCES_ALLOW_PRIVATE: 'true' });
      admin = await signUp(h, 'admin');
    }, 120_000);
    afterAll(async () => {
      await h?.close();
      await src?.drop();
    });

    it('lists tables, suggests a mapping, and previews an import without changing anything', async () => {
      const browse = await admin.client.post('/api/data-sources/browse', { connection: connection() });
      expect(browse.status).toBe(200);
      expect(browse.body.tables).toEqual(expect.arrayContaining(['Tool Master', 'inventory']));

      const table = await admin.client.post('/api/data-sources/browse/table', { connection: connection(), table: 'Tool Master' });
      expect(table.body.columns.map((c: { name: string }) => c.name)).toEqual(['Tool ID', 'Description', 'Type', 'Last Cal', 'Cal Interval', 'Notes']);
      expect(table.body.preview).toHaveLength(4);
      expect(table.body.suggested).toEqual({
        assetTag: 'Tool ID', name: 'Description', category: 'Type', lastCalibratedOn: 'Last Cal', calibrationIntervalDays: 'Cal Interval',
      });

      const preview = await admin.client.post('/api/data-sources/preview', {
        connection: connection(), table: 'Tool Master', mapping: table.body.suggested, dateOrder: 'dmy',
      });
      expect(preview.body.result).toMatchObject({ rows: 4, created: 3, skipped: 1 });
      expect((await admin.client.get('/api/tools')).body.tools).toHaveLength(0);
    });

    it('saves an import connection, imports, and never shows the password again', async () => {
      const res = await admin.client.post('/api/data-sources', {
        name: `${kind} tool master`, mode: 'import', connection: connection(), table: 'Tool Master',
        mapping: { assetTag: 'Tool ID', name: 'Description', category: 'Type', lastCalibratedOn: 'Last Cal', calibrationIntervalDays: 'Cal Interval' },
        schedule: 'daily',
      });
      expect(res.status).toBe(201);
      expect(res.body.run).toMatchObject({ ok: true, import: { created: 3, skipped: 1 } });
      const tools = (await admin.client.get('/api/tools')).body.tools as { assetTag: string; calibrationState: string }[];
      expect(tools.map((t) => [t.assetTag, t.calibrationState])).toEqual([
        ['ML-200', 'not_required'], ['TQ-100', 'ok'], ['TQ-101', 'expired'],
      ]);

      const list = await admin.client.get('/api/data-sources');
      const saved = list.body.sources.find((s: { id: string }) => s.id === res.body.id);
      expect(saved).toMatchObject({ mode: 'import', schedule: 'daily', lastSyncOk: true, tableName: 'Tool Master' });
      expect(saved.nextSyncAt).toBeTruthy();
      expect(JSON.stringify(list.body)).not.toContain(connection().password);
      const audit = JSON.stringify((await admin.client.get('/api/audit')).body);
      expect(audit).toContain('data.source_added');
      expect(audit).not.toContain(connection().password);

      // Again: nothing new. Then the source changes and the next sync picks it up.
      expect((await admin.client.post(`/api/data-sources/${res.body.id}/sync`)).body.run.import).toMatchObject({ created: 0, unchanged: 3 });
      await src.exec(`UPDATE ${kind === 'mysql' ? '`Tool Master`' : kind === 'mssql' ? '[Tool Master]' : '"Tool Master"'} SET ${kind === 'mysql' ? '`Description`' : kind === 'mssql' ? '[Description]' : '"Description"'} = 'Digital Multimeter' WHERE ${kind === 'mysql' ? '`Tool ID`' : kind === 'mssql' ? '[Tool ID]' : '"Tool ID"'} = 'ML-200'`);
      expect((await admin.client.post(`/api/data-sources/${res.body.id}/sync`)).body.run.import).toMatchObject({ updated: 1 });

      const pw = await admin.client.patch(`/api/data-sources/${res.body.id}`, { password: 'wrong-password' });
      expect(pw.status).toBe(200);
      const failed = await admin.client.post(`/api/data-sources/${res.body.id}/sync`);
      expect(failed.body.run).toMatchObject({ ok: false, message: expect.stringMatching(/refused the user name or password/) });
    });

    it('creates a copy table and keeps it filled', async () => {
      const res = await admin.client.post('/api/data-sources', {
        name: `${kind} copy`, mode: 'mirror', connection: connection(), table: 'tooltrace_tools',
      });
      expect(res.status).toBe(201);
      expect(res.body.run).toMatchObject({ ok: true, copied: 3 });
      const rows = await src.exec('SELECT asset_tag, name, status, calibration_state FROM tooltrace_tools ORDER BY asset_tag');
      expect(rows).toEqual([
        { asset_tag: 'ML-200', name: 'Digital Multimeter', status: 'available', calibration_state: 'not_required' },
        { asset_tag: 'TQ-100', name: 'Torque Wrench 10-50 Nm', status: 'available', calibration_state: 'ok' },
        { asset_tag: 'TQ-101', name: 'Torque Wrench 40-200 Nm', status: 'available', calibration_state: 'expired' },
      ]);
      expect((await admin.client.post(`/api/data-sources/${res.body.id}/sync`)).body.run).toMatchObject({ ok: true, copied: 3 });
      expect(await src.exec('SELECT asset_tag FROM tooltrace_tools')).toHaveLength(3);
    });

    it('runs scheduled syncs as the admin who set them up, and pauses if they stop being one', async () => {
      const res = await admin.client.post('/api/data-sources', {
        name: `${kind} nightly`, mode: 'mirror', connection: connection(), table: 'tooltrace_nightly', schedule: 'hourly',
      });
      const runner = new DataSources(h.sql, h.config);
      expect(await runner.runDue()).toBe(0); // not due yet
      await h.sql`UPDATE data_sources SET next_sync_at = now() - interval '1 minute' WHERE id = ${res.body.id}`;
      expect(await runner.runDue()).toBe(1);
      const runs = (await admin.client.get('/api/data-sources')).body.runs;
      expect(runs[0]).toMatchObject({ sourceId: res.body.id, trigger: 'schedule', ok: true });

      await h.sql`UPDATE users SET role = 'storekeeper' WHERE id = ${admin.user.id}`;
      await h.sql`UPDATE data_sources SET next_sync_at = now() - interval '1 minute' WHERE id = ${res.body.id}`;
      await runner.runDue();
      const [paused] = await h.sql`SELECT last_sync_ok, last_sync_message, next_sync_at FROM data_sources WHERE id = ${res.body.id}`;
      expect(paused).toMatchObject({ lastSyncOk: false, nextSyncAt: null, lastSyncMessage: expect.stringMatching(/no longer an admin/) });
      await h.sql`UPDATE users SET role = 'admin' WHERE id = ${admin.user.id}`;
    });

    it('refuses tables it did not list, and never overwrites someone else\'s table', async () => {
      const injected = await admin.client.post('/api/data-sources/browse/table', { connection: connection(), table: 'inventory; DROP TABLE inventory' });
      expect(injected.status).toBe(422);
      const clash = await admin.client.post('/api/data-sources', { name: 'clash', mode: 'mirror', connection: connection(), table: 'inventory' });
      expect(clash.status).toBe(422);
      expect(clash.body.error.message).toMatch(/not made by ToolTrace/);
      expect(await src.exec('SELECT * FROM inventory')).toEqual([]);
    });

    it('explains connection problems in plain words', async () => {
      const bad = await admin.client.post('/api/data-sources/browse', { connection: connection({ password: 'nope' }) });
      expect(bad.status).toBe(422);
      expect(bad.body.error.message).toMatch(/refused the user name or password/);
      const closed = await admin.client.post('/api/data-sources/browse', { connection: connection({ port: 1 }) });
      expect(closed.body.error.message).toMatch(/Nothing is accepting connections/);
    });
  });
}

describe('without permission for private networks', () => {
  it('will not connect to the server\'s own network', async () => {
    const h = await createHarness({ DATA_SOURCE_KEY: KEY });
    try {
      const admin = await signUp(h, 'admin');
      for (const host of ['localhost', '127.0.0.1', '169.254.169.254', '10.0.0.5']) {
        const res = await admin.client.post('/api/data-sources/browse', {
          connection: { kind: 'postgres', host, database: 'postgres', username: 'postgres', password: 'postgres' },
        });
        expect(res.status, host).toBe(422);
        expect(res.body.error.message, host).toMatch(/private or local|not allowed/);
      }
    } finally {
      await h.close();
    }
  });
});
