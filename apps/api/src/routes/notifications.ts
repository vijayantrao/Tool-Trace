import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../lib/validate.js';
import { db } from '../middleware/db.js';
import { currentUser, requireAuth, requireRole } from '../middleware/session.js';
import type { AppEnv, Deps } from '../types.js';

export function notificationRoutes({ notifier }: Deps) {
  const app = new Hono<AppEnv>();

  /** The bell: newest first, with the unread count and whether email reaches this person. */
  app.get(
    '/notifications',
    requireAuth,
    validate('query', z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) })),
    async (c) => {
      const user = currentUser(c);
      const sql = db(c);
      const { limit } = c.req.valid('query');
      const notifications = await sql`
        SELECT id, kind, title, body, link, created_at, read_at
        FROM notifications WHERE user_id = ${user.id}
        ORDER BY created_at DESC LIMIT ${limit}`;
      const [{ unread }] = (await sql`
        SELECT count(*)::int AS unread FROM notifications WHERE user_id = ${user.id} AND read_at IS NULL`) as unknown as [
        { unread: number },
      ];
      const [pref] = await sql<{ email: boolean }[]>`SELECT email FROM notification_preferences WHERE user_id = ${user.id}`;
      return c.json({
        notifications,
        unread,
        email: { available: notifier.emailOn, enabled: pref?.email ?? true, address: user.email },
      });
    },
  );

  app.post(
    '/notifications/read',
    requireAuth,
    validate('json', z.union([z.object({ ids: z.array(z.uuid()).min(1).max(100) }), z.object({ all: z.literal(true) })])),
    async (c) => {
      const user = currentUser(c);
      const body = c.req.valid('json');
      const ids = 'ids' in body ? body.ids : null;
      const rows = await db(c)`
        UPDATE notifications SET read_at = now()
        WHERE user_id = ${user.id} AND read_at IS NULL AND (${ids}::uuid[] IS NULL OR id = ANY(${ids}::uuid[]))
        RETURNING id`;
      return c.json({ marked: rows.length });
    },
  );

  app.put('/notifications/preferences', requireAuth, validate('json', z.object({ email: z.boolean() })), async (c) => {
    const user = currentUser(c);
    const { email } = c.req.valid('json');
    await db(c)`
      INSERT INTO notification_preferences (user_id, email) VALUES (${user.id}, ${email})
      ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, updated_at = now()`;
    return c.json({ email });
  });

  /** For admins: is email actually going out? Counts and the latest error, never the messages. */
  app.get('/notifications/delivery', requireRole('admin'), async (c) => {
    const [counts] = await db(c)`
      SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
             count(*) FILTER (WHERE status = 'sent' AND sent_at > now() - interval '7 days')::int AS sent_last_week,
             count(*) FILTER (WHERE status = 'failed')::int AS failed,
             (SELECT last_error FROM email_outbox WHERE last_error IS NOT NULL ORDER BY created_at DESC LIMIT 1) AS last_error
      FROM email_outbox`;
    return c.json({ available: notifier.emailOn, ...counts });
  });

  return app;
}
