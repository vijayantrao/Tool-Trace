import { Hono } from 'hono';
import { z } from 'zod';
import type { Sql, TxSql } from '../db.js';
import { conflict, notFound } from '../lib/errors.js';
import { normalizeUid } from '../lib/uid.js';
import { validate } from '../lib/validate.js';
import { db } from '../middleware/db.js';
import { currentUser, requireAuth, requireRole } from '../middleware/session.js';
import type { AppEnv, Deps } from '../types.js';

export const DUE_SOON_DAYS = 14;

const idParam = z.object({ id: z.uuid() });
const isoDate = z.iso.date();
/** Accepts "c0:ff:ee:99", "C0 FF EE 99"... and normalises to "C0FFEE99". */
const rfidUid = z
  .string()
  .max(40)
  .transform((v, ctx) => {
    const uid = normalizeUid(v);
    if (!uid) ctx.addIssue({ code: 'custom', message: 'RFID tag must be 4, 7 or 10 bytes of hex, like 11:22:33:44' });
    return uid ?? '';
  });
const assetTag = z.string().trim().regex(/^[A-Z0-9][A-Z0-9-]{2,31}$/, 'Use 3-32 uppercase letters, digits or dashes');

/** Shared SELECT list. calibration_state is computed, never stored, so it can't go stale. */
const toolColumns = (sql: Sql | TxSql) => sql`
  t.id, t.asset_tag, t.name, t.category, t.status, t.rfid_uid,
  t.home_location_id, l.name AS home_location_name,
  t.requires_calibration, t.calibration_interval_days,
  t.last_calibrated_on::text AS last_calibrated_on,
  t.calibration_due_on::text AS calibration_due_on,
  CASE
    WHEN NOT t.requires_calibration THEN 'not_required'
    WHEN t.calibration_due_on < current_date THEN 'expired'
    WHEN t.calibration_due_on <= current_date + ${DUE_SOON_DAYS}::int THEN 'due_soon'
    ELSE 'ok'
  END AS calibration_state,
  co.holder_id, h.display_name AS holder_name, co.due_back_at,
  COALESCE(co.due_back_at < now(), false) AS overdue,
  t.created_at, t.updated_at`;

/** Tools joined with their location and current open checkout (if any). */
const toolFrom = (sql: Sql | TxSql) => sql`
  tools t
  JOIN locations l ON l.id = t.home_location_id
  LEFT JOIN checkouts co ON co.tool_id = t.id AND co.returned_at IS NULL
  LEFT JOIN users h ON h.id = co.holder_id`;

export function toolRoutes(_deps: Deps) {
  const app = new Hono<AppEnv>();

  // --- Locations -------------------------------------------------------------
  app.get('/locations', requireAuth, async (c) => {
    const locations = await db(c)`SELECT id, name, kind FROM locations ORDER BY name`;
    return c.json({ locations });
  });

  app.post(
    '/locations',
    requireRole('admin', 'storekeeper'),
    validate('json', z.object({ name: z.string().trim().min(1).max(80), kind: z.enum(['crib', 'bay', 'line', 'external']) })),
    async (c) => {
      const body = c.req.valid('json');
      const [location] = await db(c)`INSERT INTO locations (name, kind) VALUES (${body.name}, ${body.kind}) RETURNING id, name, kind`;
      return c.json({ location }, 201);
    },
  );

  // --- Tools -----------------------------------------------------------------
  app.get(
    '/tools',
    requireAuth,
    validate(
      'query',
      z.object({
        status: z.enum(['available', 'checked_out', 'quarantined', 'retired']).optional(),
        calibration: z.enum(['not_required', 'ok', 'due_soon', 'expired']).optional(),
        q: z.string().trim().max(60).optional(),
      }),
    ),
    async (c) => {
      const f = c.req.valid('query');
      const like = f.q ? `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
      const sql = db(c);
      const tools = await sql`
        SELECT * FROM (
          SELECT ${toolColumns(sql)}
          FROM ${toolFrom(sql)}
        ) x
        WHERE (${f.status ?? null}::tool_status IS NULL OR x.status = ${f.status ?? null}::tool_status)
          AND (${f.calibration ?? null}::text IS NULL OR x.calibration_state = ${f.calibration ?? null})
          AND (${like}::text IS NULL OR x.asset_tag ILIKE ${like} OR x.name ILIKE ${like})
        ORDER BY x.asset_tag
        LIMIT 500`;
      return c.json({ tools });
    },
  );

  const getTool = async (sql: TxSql, where: { id?: string; assetTag?: string }) => {
    const [tool] = await sql`
      SELECT ${toolColumns(sql)}
      FROM ${toolFrom(sql)}
      WHERE ${where.id ? sql`t.id = ${where.id}` : sql`t.asset_tag = ${where.assetTag!}`}`;
    if (!tool) throw notFound('Tool');
    const [openCheckout] = await sql`
      SELECT c.id, c.holder_id, u.display_name AS holder_name, c.checked_out_at, c.due_back_at,
             c.due_back_at < now() AS overdue
      FROM checkouts c JOIN users u ON u.id = c.holder_id
      WHERE c.tool_id = ${tool.id} AND c.returned_at IS NULL`;
    const calibrations = await sql`
      SELECT id, calibrated_on::text, due_on::text, certificate_ref, performed_by, created_at
      FROM calibration_records WHERE tool_id = ${tool.id}
      ORDER BY calibrated_on DESC LIMIT 5`;
    return { ...tool, openCheckout: openCheckout ?? null, calibrations };
  };

  app.get('/tools/by-tag/:assetTag', requireAuth, validate('param', z.object({ assetTag })), async (c) =>
    c.json({ tool: await getTool(db(c), { assetTag: c.req.valid('param').assetTag }) }),
  );

  app.get('/tools/:id', requireAuth, validate('param', idParam), async (c) =>
    c.json({ tool: await getTool(db(c), { id: c.req.valid('param').id }) }),
  );

  app.post(
    '/tools',
    requireRole('admin', 'storekeeper'),
    validate(
      'json',
      z
        .object({
          assetTag,
          name: z.string().trim().min(1).max(120),
          category: z.string().trim().min(1).max(60),
          homeLocationId: z.uuid(),
          requiresCalibration: z.boolean().default(false),
          calibrationIntervalDays: z.number().int().min(1).max(3650).optional(),
          lastCalibratedOn: isoDate.optional(),
          rfidUid: rfidUid.optional(),
        })
        .refine(
          (v) => !v.requiresCalibration || (v.calibrationIntervalDays && v.lastCalibratedOn),
          { message: 'Calibrated tools need calibrationIntervalDays and lastCalibratedOn', path: ['requiresCalibration'] },
        ),
    ),
    async (c) => {
      const b = c.req.valid('json');
      const cal = b.requiresCalibration;
      const [created] = await db(c)<{ id: string }[]>`
        INSERT INTO tools (asset_tag, name, category, home_location_id, rfid_uid, requires_calibration,
                           calibration_interval_days, last_calibrated_on, calibration_due_on)
        VALUES (${b.assetTag}, ${b.name}, ${b.category}, ${b.homeLocationId}, ${b.rfidUid ?? null}, ${cal},
                ${cal ? b.calibrationIntervalDays! : null},
                ${cal ? b.lastCalibratedOn! : null}::date,
                ${cal ? b.lastCalibratedOn! : null}::date + ${cal ? b.calibrationIntervalDays! : 0}::int)
        RETURNING id`;
      return c.json({ tool: await getTool(db(c), { id: created!.id }) }, 201);
    },
  );

  app.patch(
    '/tools/:id',
    requireRole('admin', 'storekeeper'),
    validate('param', idParam),
    validate(
      'json',
      z
        .object({
          name: z.string().trim().min(1).max(120).optional(),
          category: z.string().trim().min(1).max(60).optional(),
          homeLocationId: z.uuid().optional(),
          status: z.enum(['available', 'quarantined', 'retired']).optional(),
          /** RFID tag stuck on the tool, or null to remove it. */
          rfidUid: rfidUid.nullable().optional(),
        })
        .refine((v) => Object.keys(v).length > 0, 'Nothing to update'),
    ),
    async (c) => {
      const { id } = c.req.valid('param');
      const b = c.req.valid('json');
      const tx = db(c);
      {
        const [tool] = await tx<{ status: string }[]>`SELECT status FROM tools WHERE id = ${id} FOR UPDATE`;
        if (!tool) throw notFound('Tool');
        if (b.status && tool.status === 'checked_out') {
          throw conflict('tool_checked_out', 'Return the tool before changing its status');
        }
        await tx`
          UPDATE tools SET
            name = COALESCE(${b.name ?? null}, name),
            category = COALESCE(${b.category ?? null}, category),
            home_location_id = COALESCE(${b.homeLocationId ?? null}::uuid, home_location_id),
            status = COALESCE(${b.status ?? null}::tool_status, status),
            rfid_uid = CASE WHEN ${b.rfidUid !== undefined} THEN ${b.rfidUid ?? null} ELSE rfid_uid END
          WHERE id = ${id}`;
      }
      return c.json({ tool: await getTool(tx, { id }) });
    },
  );

  app.post(
    '/tools/:id/calibrations',
    requireRole('admin', 'storekeeper'),
    validate('param', idParam),
    validate(
      'json',
      z.object({
        calibratedOn: isoDate,
        performedBy: z.string().trim().min(1).max(120),
        certificateRef: z.string().trim().max(120).optional(),
      }),
    ),
    async (c) => {
      const { id } = c.req.valid('param');
      const b = c.req.valid('json');
      const user = currentUser(c);
      const tx = db(c);
      {
        const [tool] = await tx<{ status: string; requiresCalibration: boolean; future: boolean }[]>`
          SELECT status, requires_calibration, ${b.calibratedOn}::date > current_date AS future
          FROM tools WHERE id = ${id} FOR UPDATE`;
        if (!tool) throw notFound('Tool');
        if (!tool.requiresCalibration) throw conflict('calibration_not_required', 'This tool is not calibration-controlled');
        if (tool.status === 'checked_out') throw conflict('tool_checked_out', 'Return the tool before recording calibration');
        if (tool.future) throw conflict('future_date', 'Calibration date cannot be in the future');

        const [rec] = await tx<{ dueOn: string }[]>`
          INSERT INTO calibration_records (tool_id, calibrated_on, due_on, certificate_ref, performed_by, recorded_by)
          SELECT ${id}, ${b.calibratedOn}::date, ${b.calibratedOn}::date + calibration_interval_days,
                 ${b.certificateRef ?? null}, ${b.performedBy}, ${user.id}
          FROM tools WHERE id = ${id}
          RETURNING due_on::text`;
        // A fresh calibration releases a quarantined tool back into service.
        await tx`
          UPDATE tools SET
            last_calibrated_on = GREATEST(last_calibrated_on, ${b.calibratedOn}::date),
            calibration_due_on = GREATEST(calibration_due_on, ${rec!.dueOn}::date),
            status = CASE WHEN status = 'quarantined' THEN 'available'::tool_status ELSE status END
          WHERE id = ${id}`;
      }
      return c.json({ tool: await getTool(tx, { id }) }, 201);
    },
  );

  return app;
}
