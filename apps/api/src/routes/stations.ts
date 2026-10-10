import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, notFound } from '../lib/errors.js';
import { formatUid } from '../lib/uid.js';
import { validate } from '../lib/validate.js';
import { requireRole } from '../middleware/session.js';
import type { AppEnv, Deps } from '../types.js';

const ONLINE_WITHIN_SECONDS = 150;

export function stationRoutes({ sql, gateway }: Deps) {
  const app = new Hono<AppEnv>();
  const idParam = z.object({ id: z.uuid() });
  const requireEnabled = () => {
    if (!gateway.enabled) {
      throw new ApiError(503, 'stations_disabled', 'Smart stations are not set up on this server (STATION_MASTER_KEY is missing)');
    }
  };

  /** Shown once at creation or key rotation: everything the firmware needs. */
  const provisioning = (station: { id: string; keyVersion: number }) => {
    const key = gateway.keyFor(station.id, station.keyVersion).toString('hex');
    return {
      stationId: station.id,
      keyVersion: station.keyVersion,
      stationKey: key,
      eventsTopic: gateway.eventsTopic(station.id),
      repliesTopic: gateway.repliesTopic(station.id),
      firmwareConfig: [
        `// Station "${station.id}", key version ${station.keyVersion}.`,
        '// Keep this secret: anyone with the key can act as this station.',
        `#define STATION_ID "${station.id}"`,
        `#define STATION_KEY_HEX "${key}"`,
        `#define MQTT_TOPIC_PREFIX "${gateway.topicPrefix}"`,
      ].join('\n'),
    };
  };

  app.get('/stations', requireRole('admin', 'storekeeper', 'auditor'), async (c) => {
    const stations = await sql`
      SELECT s.id, s.name, s.location_id, l.name AS location_name, s.is_active, s.key_version,
             s.last_seen_at, COALESCE(s.last_seen_at > now() - make_interval(secs => ${ONLINE_WITHIN_SECONDS}), false) AS online
      FROM stations s JOIN locations l ON l.id = s.location_id
      ORDER BY s.name`;
    return c.json({ stations, enabled: gateway.enabled });
  });

  app.post(
    '/stations',
    requireRole('admin'),
    validate('json', z.object({ name: z.string().trim().min(1).max(60), locationId: z.uuid() })),
    async (c) => {
      requireEnabled();
      const b = c.req.valid('json');
      const [station] = await sql<{ id: string; name: string; keyVersion: number }[]>`
        INSERT INTO stations (name, location_id) VALUES (${b.name}, ${b.locationId})
        RETURNING id, name, key_version`;
      return c.json({ station, provisioning: provisioning(station!) }, 201);
    },
  );

  app.post('/stations/:id/rotate-key', requireRole('admin'), validate('param', idParam), async (c) => {
    const { id } = c.req.valid('param');
    requireEnabled();
    const [station] = await sql<{ id: string; name: string; keyVersion: number }[]>`
      UPDATE stations SET key_version = key_version + 1, session_user_id = NULL, session_expires_at = NULL
      WHERE id = ${id} RETURNING id, name, key_version`;
    if (!station) throw notFound('Station');
    return c.json({ station, provisioning: provisioning(station) });
  });

  app.patch(
    '/stations/:id',
    requireRole('admin'),
    validate('param', idParam),
    validate(
      'json',
      z
        .object({ name: z.string().trim().min(1).max(60).optional(), isActive: z.boolean().optional() })
        .refine((v) => v.name !== undefined || v.isActive !== undefined, 'Nothing to update'),
    ),
    async (c) => {
      const { id } = c.req.valid('param');
      const b = c.req.valid('json');
      const [station] = await sql`
        UPDATE stations SET name = COALESCE(${b.name ?? null}, name),
                            is_active = COALESCE(${b.isActive ?? null}::boolean, is_active)
        WHERE id = ${id} RETURNING id, name, is_active, key_version`;
      if (!station) throw notFound('Station');
      return c.json({ station });
    },
  );

  app.get(
    '/station-events',
    requireRole('admin', 'storekeeper', 'auditor'),
    validate('query', z.object({ stationId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) })),
    async (c) => {
      const q = c.req.valid('query');
      const rows = await sql<{ uid: string | null }[]>`
        SELECT e.id, e.station_id, s.name AS station_name, e.received_at, e.kind, e.uid, e.outcome, e.code,
               e.user_id, u.display_name AS user_name, e.tool_id, t.asset_tag
        FROM station_events e
        JOIN stations s ON s.id = e.station_id
        LEFT JOIN users u ON u.id = e.user_id
        LEFT JOIN tools t ON t.id = e.tool_id
        WHERE (${q.stationId ?? null}::uuid IS NULL OR e.station_id = ${q.stationId ?? null}::uuid)
        ORDER BY e.id DESC
        LIMIT ${q.limit}`;
      return c.json({ events: rows.map((r) => ({ ...r, uid: r.uid ? formatUid(r.uid) : null })) });
    },
  );

  return app;
}
