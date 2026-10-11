import { Hono } from 'hono';
import { z } from 'zod';
import { notFound } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { db } from '../middleware/db.js';
import { currentUser, requireRole } from '../middleware/session.js';
import type { AppEnv, Deps } from '../types.js';

/** A tool is "likely late" from this probability, and "at risk of loss" from this one. */
export const LIKELY_LATE = 0.5;
export const LOSS_RISK = 0.25;

// JSON columns are read as text: the camelCase transform must not rewrite keys inside model output.
const parse = <T>(text: string | null): T | null => (text ? (JSON.parse(text) as T) : null);

export function insightRoutes(_deps: Deps) {
  const app = new Hono<AppEnv>();

  app.get('/insights', requireRole('admin', 'storekeeper', 'auditor'), async (c) => {
    const sql = db(c);
    const runs = await sql<
      {
        id: string;
        startedAt: Date;
        finishedAt: Date | null;
        status: string;
        modelVersion: string;
        trainedOn: number | null;
        metricsJson: string;
        error: string | null;
      }[]
    >`
      (SELECT id, started_at, finished_at, status, model_version, trained_on, metrics::text AS metrics_json, error
       FROM ml_runs ORDER BY started_at DESC LIMIT 1)
      UNION ALL
      (SELECT id, started_at, finished_at, status, model_version, trained_on, metrics::text AS metrics_json, error
       FROM ml_runs WHERE status = 'succeeded' ORDER BY started_at DESC LIMIT 1)`;
    const toRun = (r: (typeof runs)[number] | undefined) =>
      r && { ...r, metricsJson: undefined, metrics: parse<Record<string, unknown>>(r.metricsJson) ?? {} };

    const atRisk = await sql<{ factorsJson: string | null }[]>`
      SELECT c.id AS checkout_id, c.tool_id, t.asset_tag, t.name AS tool_name, t.category,
             c.holder_id, h.display_name AS holder_name, c.checked_out_at, c.due_back_at, c.offline_queued_at,
             c.due_back_at < now() AS overdue,
             r.late_probability, r.loss_probability, r.factors::text AS factors_json, r.scored_at
      FROM checkouts c
      JOIN tools t ON t.id = c.tool_id
      JOIN users h ON h.id = c.holder_id
      LEFT JOIN risk_scores r ON r.checkout_id = c.id
      WHERE c.returned_at IS NULL
      ORDER BY r.loss_probability DESC NULLS LAST, r.late_probability DESC NULLS LAST, c.due_back_at`;

    const anomalies = await sql<{ reasonsJson: string }[]>`
      SELECT a.id, a.checkout_id, a.score, a.reasons::text AS reasons_json, a.detected_at, a.status,
             a.review_note, a.reviewed_at, rv.display_name AS reviewed_by_name,
             c.tool_id, t.asset_tag, t.name AS tool_name, h.display_name AS holder_name,
             c.checked_out_at, c.due_back_at, c.returned_at
      FROM anomalies a
      JOIN checkouts c ON c.id = a.checkout_id
      JOIN tools t ON t.id = c.tool_id
      JOIN users h ON h.id = c.holder_id
      LEFT JOIN users rv ON rv.id = a.reviewed_by
      ORDER BY (a.status = 'open') DESC, a.detected_at DESC, a.score DESC
      LIMIT 50`;

    return c.json({
      latestRun: toRun(runs[0]) ?? null,
      lastSuccessfulRun: toRun(runs.find((r) => r.status === 'succeeded')) ?? null,
      thresholds: { likelyLate: LIKELY_LATE, lossRisk: LOSS_RISK },
      atRisk: atRisk.map(({ factorsJson, ...r }) => ({ ...r, factors: parse(factorsJson) ?? [] })),
      anomalies: anomalies.map(({ reasonsJson, ...a }) => ({ ...a, reasons: parse(reasonsJson) ?? [] })),
    });
  });

  app.post(
    '/anomalies/:id/review',
    requireRole('admin', 'storekeeper'),
    validate('param', z.object({ id: z.uuid() })),
    validate(
      'json',
      z.object({
        status: z.enum(['confirmed', 'dismissed']),
        note: z.string().trim().max(500).optional(),
      }),
    ),
    async (c) => {
      const { id } = c.req.valid('param');
      const b = c.req.valid('json');
      const user = currentUser(c);
      const [anomaly] = await db(c)`
        UPDATE anomalies
        SET status = ${b.status}, review_note = ${b.note || null}, reviewed_by = ${user.id}, reviewed_at = now()
        WHERE id = ${id}
        RETURNING id, checkout_id, status, review_note, reviewed_at`;
      if (!anomaly) throw notFound('Anomaly');
      return c.json({ anomaly });
    },
  );

  return app;
}
