/**
 * Data sources (admins): import the tool list from an Excel/CSV file or a
 * database, or have ToolTrace create and keep a copy table in a database.
 *
 * These routes manage their own short transactions (see services/data-sources/
 * sync.ts) because they may wait on an outside database, which must never
 * happen while holding the audit-trail lock.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ApiError, notFound } from '../lib/errors.js';
import { isValidHost } from '../lib/net-guard.js';
import { rateLimit } from '../lib/rate-limit.js';
import { validate } from '../lib/validate.js';
import { clientIp } from '../middleware/db.js';
import { currentUser, requireRole } from '../middleware/session.js';
import { DEFAULT_PORTS, pickTable, SourceError, type Connection, type ConnectionSettings } from '../services/data-sources/connectors.js';
import { importTools, suggestMapping, TOOL_FIELDS } from '../services/data-sources/import.js';
import { DataSources, describeImport, runSummary, secretContext } from '../services/data-sources/sync.js';
import type { AppEnv, Deps } from '../types.js';

const fieldKeys = TOOL_FIELDS.map((f) => f.key) as [string, ...string[]];
const dateOrder = z.enum(['dmy', 'mdy']).default('dmy');
const mapping = z.partialRecord(z.enum(fieldKeys), z.string().min(1).max(128));
const cell = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);

const connection = z.object({
  kind: z.enum(['mysql', 'postgres', 'mssql']),
  host: z.string().trim().min(1).max(253).refine(isValidHost, 'Enter a host name like db.company.com, or an IP address'),
  port: z.number().int().min(1).max(65535).optional(),
  database: z.string().trim().min(1).max(128),
  username: z.string().trim().min(1).max(128),
  password: z.string().max(512),
  tls: z.enum(['verify', 'require', 'off']).default('verify'),
});
type ConnectionInput = z.infer<typeof connection>;
const settings = (c: ConnectionInput): ConnectionSettings => ({ ...c, port: c.port ?? DEFAULT_PORTS[c.kind] });

const idParam = z.object({ id: z.uuid() });
const schedule = z.enum(['manual', 'hourly', 'daily']);

/** Rows from an outside database, made safe to send as JSON (and short). */
function jsonSafe(rows: Record<string, unknown>[]) {
  const v = (x: unknown): unknown => {
    if (x === null || x === undefined) return null;
    if (x instanceof Date) return Number.isNaN(x.getTime()) ? null : x.toISOString();
    if (Buffer.isBuffer(x)) return '(binary)';
    if (typeof x === 'bigint') return x.toString();
    if (typeof x === 'string') return x.length > 200 ? `${x.slice(0, 200)}…` : x;
    if (typeof x === 'object') return JSON.stringify(x).slice(0, 200);
    return x;
  };
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k, v(x)])));
}

export function dataSourceRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const ds: DataSources = deps.dataSources!;
  const admin = requireRole('admin');
  // Each try at an outside server costs a connection attempt: keep them human-paced.
  const outbound = rateLimit({
    name: 'data-sources',
    limit: 30,
    windowMs: 60_000,
    store: deps.limiter,
    trustProxy: deps.config.TRUST_PROXY,
    key: (c) => (c as Context<AppEnv>).get('user')?.id ?? 'anonymous',
  });
  const actorOf = (c: Context<AppEnv>) => {
    const user = currentUser(c);
    return { role: user.role, userId: user.id, ip: clientIp(c, deps.config.TRUST_PROXY) };
  };
  const needDatabases = () => {
    const d = ds.databases;
    if (!d.enabled) throw new ApiError(403, 'databases_disabled', d.reason!);
  };
  /** Opens a connection for the request, always closing it, and turns driver errors into plain ones. */
  const withConnection = async <T>(input: ConnectionInput, fn: (conn: Connection) => Promise<T>): Promise<T> => {
    needDatabases();
    let conn: Connection | undefined;
    try {
      conn = await ds.open(settings(input));
      return await fn(conn);
    } catch (err) {
      if (err instanceof SourceError) throw new ApiError(422, 'source_error', err.message);
      throw err;
    } finally {
      await conn?.close();
    }
  };

  app.get('/data-sources', admin, async (c) => {
    const actor = actorOf(c);
    const { sources, runs } = await ds.read(actor, async (tx) => ({
      sources: await tx`
        SELECT id, name, kind, mode, host, port, database_name, username, tls, table_name, mapping, schedule,
               next_sync_at, last_sync_at, last_sync_ok, last_sync_message, created_at
        FROM data_sources ORDER BY name`,
      runs: await tx`
        SELECT r.id, r.source_id, r.source_label, r.kind, r.direction, r.trigger, r.ok, r.summary, r.at, u.display_name AS run_by_name
        FROM data_sync_runs r JOIN users u ON u.id = r.run_by
        ORDER BY r.at DESC LIMIT 30`,
    }));
    return c.json({
      sources,
      runs,
      fields: TOOL_FIELDS,
      capabilities: { databases: ds.databases, maxFileRows: ds.maxFileRows, defaultPorts: DEFAULT_PORTS },
    });
  });

  // ---- Excel / CSV: the browser reads the file and sends the mapped rows ----
  app.post(
    '/data-sources/files/import',
    admin,
    validate(
      'json',
      z.object({
        fileName: z.string().trim().min(1).max(200),
        fileKind: z.enum(['excel', 'csv']),
        dateOrder,
        dryRun: z.boolean().default(false),
        rows: z.array(z.object({ row: z.number().int().min(1), values: z.partialRecord(z.enum(fieldKeys), cell) })).min(1).max(5000),
      }),
    ),
    async (c) => {
      const b = c.req.valid('json');
      if (b.rows.length > ds.maxFileRows) {
        throw new ApiError(422, 'too_many_rows', `Import up to ${ds.maxFileRows} rows at a time.`);
      }
      const actor = actorOf(c);
      const opts = { sourceLabel: b.fileName, dateOrder: b.dateOrder, actorUserId: actor.userId };
      if (b.dryRun) return c.json({ result: await ds.dryRun(actor, (tx) => importTools(tx, b.rows, opts)) });
      const result = await ds.write(actor, async (tx) => {
        const r = await importTools(tx, b.rows, opts);
        await tx`
          INSERT INTO data_sync_runs (source_label, kind, direction, trigger, ok, summary, run_by)
          VALUES (${b.fileName}, ${b.fileKind}, 'import', 'manual', true,
                  ${tx.json(runSummary({ ok: true, message: describeImport(r), import: r }))}, ${actor.userId})`;
        return r;
      });
      return c.json({ result });
    },
  );

  // ---- Databases: look around before saving anything ----
  app.post('/data-sources/browse', admin, outbound, validate('json', z.object({ connection })), async (c) => {
    const { connection: conn } = c.req.valid('json');
    const tables = await withConnection(conn, (x) => x.listTables());
    return c.json({ tables: tables.map((t) => t.label) });
  });

  app.post(
    '/data-sources/browse/table',
    admin,
    outbound,
    validate('json', z.object({ connection, table: z.string().min(1).max(260) })),
    async (c) => {
      const b = c.req.valid('json');
      const { columns, rows } = await withConnection(b.connection, async (x) => x.describe(pickTable(await x.listTables(), b.table)));
      return c.json({ columns, preview: jsonSafe(rows), suggested: suggestMapping(columns.map((col) => col.name)) });
    },
  );

  app.post(
    '/data-sources/preview',
    admin,
    outbound,
    validate('json', z.object({ connection, table: z.string().min(1).max(260), mapping, dateOrder })),
    async (c) => {
      const b = c.req.valid('json');
      const rows = await withConnection(b.connection, (x) => ds.readMapped(x, b.table, b.mapping));
      const actor = actorOf(c);
      const result = await ds.dryRun(actor, (tx) =>
        importTools(tx, rows, { sourceLabel: b.table, dateOrder: b.dateOrder, actorUserId: actor.userId }),
      );
      return c.json({ result });
    },
  );

  // ---- Saved connections ----
  app.post(
    '/data-sources',
    admin,
    outbound,
    validate(
      'json',
      z
        .object({
          name: z.string().trim().min(1).max(80),
          mode: z.enum(['import', 'mirror']),
          connection,
          table: z.string().trim().min(1).max(128),
          mapping: mapping.optional(),
          dateOrder,
          schedule: schedule.default('manual'),
        })
        .refine((v) => v.mode === 'mirror' || (v.mapping?.assetTag && v.mapping?.name), {
          message: 'Choose the columns for Asset tag and Name',
          path: ['mapping'],
        }),
    ),
    async (c) => {
      const b = c.req.valid('json');
      const actor = actorOf(c);
      const [taken] = await ds.read(actor, (tx) => tx`SELECT 1 FROM data_sources WHERE lower(name) = lower(${b.name})`);
      if (taken) throw new ApiError(409, 'name_taken', 'A connection with that name already exists. Choose another name.');
      // Check it all works before saving: the table (or the right to create it) and the mapped columns.
      await withConnection(b.connection, async (x) => {
        if (b.mode === 'mirror') await x.ensureMirrorTable(b.table);
        else await ds.readMapped(x, b.table, b.mapping!);
      });
      const id = crypto.randomUUID();
      const s = settings(b.connection);
      const secret = ds.box!.seal(s.password, secretContext(id));
      await ds.write(actor, (tx) => tx`
        INSERT INTO data_sources (id, name, kind, mode, host, port, database_name, username, secret, tls, table_name,
                                  mapping, schedule, next_sync_at, created_by)
        VALUES (${id}, ${b.name}, ${s.kind}, ${b.mode}, ${s.host}, ${s.port}, ${s.database}, ${s.username}, ${secret}, ${s.tls},
                ${b.table}, ${tx.json({ fields: b.mapping ?? {}, dateOrder: b.dateOrder })}, ${b.schedule},
                CASE ${b.schedule}::text WHEN 'hourly' THEN now() + interval '1 hour' WHEN 'daily' THEN now() + interval '1 day' END,
                ${actor.userId})`);
      const source = (await ds.load(actor, id))!;
      const run = await ds.sync(actor, source, { trigger: 'manual' });
      return c.json({ id, run }, 201);
    },
  );

  app.post('/data-sources/:id/sync', admin, outbound, validate('param', idParam), async (c) => {
    needDatabases();
    const actor = actorOf(c);
    const source = await ds.load(actor, c.req.valid('param').id);
    if (!source) throw notFound('Data source');
    return c.json({ run: await ds.sync(actor, source, { trigger: 'manual' }) });
  });

  app.patch(
    '/data-sources/:id',
    admin,
    validate('param', idParam),
    validate(
      'json',
      z
        .object({
          name: z.string().trim().min(1).max(80).optional(),
          schedule: schedule.optional(),
          password: z.string().max(512).optional(),
        })
        .refine((v) => Object.keys(v).length > 0, 'Nothing to update'),
    ),
    async (c) => {
      const { id } = c.req.valid('param');
      const b = c.req.valid('json');
      if (b.password !== undefined) needDatabases();
      const secret = b.password !== undefined ? ds.box!.seal(b.password, secretContext(id)) : null;
      const actor = actorOf(c);
      const [updated] = await ds.write(actor, (tx) => tx`
        UPDATE data_sources SET
          name = COALESCE(${b.name ?? null}, name),
          secret = COALESCE(${secret}::bytea, secret),
          schedule = COALESCE(${b.schedule ?? null}, schedule),
          next_sync_at = CASE
            WHEN ${b.schedule ?? null}::text IS NULL THEN next_sync_at
            WHEN ${b.schedule ?? null}::text = 'hourly' THEN now() + interval '1 hour'
            WHEN ${b.schedule ?? null}::text = 'daily' THEN now() + interval '1 day'
            ELSE NULL END
        WHERE id = ${id}
        RETURNING id`).catch((err) => {
        if ((err as { code?: string }).code === '23505') throw new ApiError(409, 'name_taken', 'A connection with that name already exists.');
        throw err;
      });
      if (!updated) throw notFound('Data source');
      return c.json({ ok: true });
    },
  );

  app.delete('/data-sources/:id', admin, validate('param', idParam), async (c) => {
    const actor = actorOf(c);
    const [gone] = await ds.write(actor, (tx) => tx`DELETE FROM data_sources WHERE id = ${c.req.valid('param').id} RETURNING id`);
    if (!gone) throw notFound('Data source');
    return c.json({ ok: true });
  });

  return app;
}

