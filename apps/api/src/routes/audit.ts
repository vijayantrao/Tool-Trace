import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../lib/validate.js';
import { db } from '../middleware/db.js';
import { requireRole } from '../middleware/session.js';
import type { AppEnv, Deps } from '../types.js';

const GENESIS: Buffer = Buffer.alloc(32);

export function auditRoutes(_deps: Deps) {
  const app = new Hono<AppEnv>();

  app.get(
    '/audit',
    requireRole('admin', 'auditor'),
    validate(
      'query',
      z.object({
        action: z.string().regex(/^[a-z_.]+$/).max(40).optional(),
        entityId: z.string().max(64).optional(),
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
    ),
    async (c) => {
      const q = c.req.valid('query');
      const like = q.action ? `${q.action}%` : null;
      const entries = await db(c)`
        SELECT a.id::int AS id, a.at, a.action, a.entity_type, a.entity_id, a.details::text AS details_json, a.actor_ip,
               a.actor_user_id, u.display_name AS actor_name,
               a.actor_station_id, s.name AS station_name,
               t.asset_tag AS tool_asset_tag,
               coalesce(t.asset_tag || ' ' || t.name, eu.display_name, es.name) AS entity_name,
               encode(a.hash, 'hex') AS hash
        FROM audit_log a
        LEFT JOIN users u ON u.id = a.actor_user_id
        LEFT JOIN stations s ON s.id = a.actor_station_id
        LEFT JOIN tools t ON a.entity_type = 'tool' AND t.id::text = a.entity_id
        LEFT JOIN users eu ON a.entity_type = 'user' AND eu.id::text = a.entity_id
        LEFT JOIN stations es ON a.entity_type = 'station' AND es.id::text = a.entity_id
        WHERE (${like}::text IS NULL OR a.action LIKE ${like})
          AND (${q.entityId ?? null}::text IS NULL OR a.entity_id = ${q.entityId ?? null})
          AND (${q.before ?? null}::bigint IS NULL OR a.id < ${q.before ?? null})
        ORDER BY a.id DESC
        LIMIT ${q.limit}`;
      // details is returned exactly as stored: the camelCase transform must not rewrite keys inside evidence.
      return c.json({
        entries: entries.map(({ detailsJson, ...e }) => ({ ...e, details: JSON.parse(detailsJson as string) })),
      });
    },
  );

  /**
   * Recomputes the whole hash chain from the stored rows.
   * Optionally checks an anchor (an id and hash recorded earlier, outside the
   * database): if someone rewrote the entire chain, the anchor won't match.
   */
  app.get(
    '/audit/verify',
    requireRole('admin', 'auditor'),
    validate(
      'query',
      z.object({
        anchorId: z.coerce.number().int().positive().optional(),
        anchorHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      }),
    ),
    async (c) => {
      const { anchorId, anchorHash } = c.req.valid('query');
      let prev: Buffer = GENESIS;
      let expectedId = 1;
      let checked = 0;
      let head: { id: number; hash: string } | null = null;
      let firstProblem: { id: number; reason: 'missing_entries' | 'broken_link' | 'content_changed' } | null = null;
      let anchor: boolean | null = anchorId && anchorHash ? false : null;

      const cursor = db(c)<{ id: string; prevHash: Buffer; hash: Buffer; payload: string }[]>`
        SELECT id, prev_hash, hash,
               audit_payload(id, at, actor_user_id, actor_station_id, actor_ip, action, entity_type, entity_id, details) AS payload
        FROM audit_log ORDER BY id`.cursor(500);

      for await (const rows of cursor) {
        for (const r of rows) {
          const id = Number(r.id);
          if (!firstProblem) {
            if (id !== expectedId) firstProblem = { id: expectedId, reason: 'missing_entries' };
            else if (!prev.equals(r.prevHash)) firstProblem = { id, reason: 'broken_link' };
            else {
              const recomputed = createHash('sha256').update(prev).update(r.payload, 'utf8').digest();
              if (!recomputed.equals(r.hash)) firstProblem = { id, reason: 'content_changed' };
            }
          }
          if (anchorId === id) anchor = r.hash.toString('hex') === anchorHash;
          prev = r.hash;
          expectedId = id + 1;
          checked++;
          head = { id, hash: r.hash.toString('hex') };
        }
      }

      return c.json({ ok: !firstProblem && anchor !== false, checked, head, firstProblem, anchorMatches: anchor });
    },
  );

  return app;
}
