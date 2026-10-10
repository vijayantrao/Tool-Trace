import { Hono } from 'hono';
import { db } from '../middleware/db.js';
import { currentUser, requireAuth } from '../middleware/session.js';
import { DUE_SOON_DAYS } from './tools.js';
import type { AppEnv, Deps } from '../types.js';

export function dashboardRoutes(_deps: Deps) {
  const app = new Hono<AppEnv>();

  /** One round-trip for the home screen: floor-wide counts plus the caller's own open checkouts. */
  app.get('/dashboard', requireAuth, async (c) => {
    const user = currentUser(c);
    const sql = db(c);
    const [counts] = await sql`
      SELECT
        count(*) FILTER (WHERE status <> 'retired')::int                       AS total,
        count(*) FILTER (WHERE status = 'available')::int                      AS available,
        count(*) FILTER (WHERE status = 'checked_out')::int                    AS checked_out,
        count(*) FILTER (WHERE status = 'quarantined')::int                    AS quarantined,
        count(*) FILTER (WHERE status <> 'retired' AND requires_calibration
                           AND calibration_due_on < current_date)::int         AS calibration_expired,
        count(*) FILTER (WHERE status <> 'retired' AND requires_calibration
                           AND calibration_due_on >= current_date
                           AND calibration_due_on <= current_date + ${DUE_SOON_DAYS}::int)::int AS calibration_due_soon,
        (SELECT count(*)::int FROM checkouts WHERE returned_at IS NULL AND due_back_at < now()) AS overdue
      FROM tools`;
    const myCheckouts = await sql`
      SELECT c.id, c.tool_id, t.asset_tag, t.name AS tool_name, c.checked_out_at, c.due_back_at,
             c.due_back_at < now() AS overdue
      FROM checkouts c JOIN tools t ON t.id = c.tool_id
      WHERE c.holder_id = ${user.id} AND c.returned_at IS NULL
      ORDER BY c.due_back_at`;
    return c.json({ counts, myCheckouts, dueSoonDays: DUE_SOON_DAYS });
  });

  return app;
}
