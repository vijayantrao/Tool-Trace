import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { ApiError } from '../lib/errors.js';
import { currentUser, requireAuth } from '../middleware/session.js';
import type { FloorEvent } from '../stations/floor-events.js';
import type { AppEnv, Deps } from '../types.js';

/**
 * GET /api/events: Server-Sent Events stream of floor changes.
 * The session is re-checked on every heartbeat, so signing out or being
 * deactivated closes the stream within seconds.
 */
export function eventRoutes({ sql, events }: Deps, heartbeatMs = 20_000) {
  const app = new Hono<AppEnv>();

  app.get('/events', requireAuth, (c) => {
    if (!events) throw new ApiError(503, 'events_unavailable', 'Live updates are not available');
    const user = currentUser(c);
    const sessionId = c.get('sessionId')!;
    c.header('X-Accel-Buffering', 'no');

    return streamSSE(c, async (stream) => {
      let open = true;
      const send = (e: FloorEvent) => {
        if (open) void stream.writeSSE({ event: 'floor', data: JSON.stringify(e) });
      };
      events.on('event', send);
      stream.onAbort(() => {
        open = false;
      });
      await stream.writeSSE({ event: 'ready', data: JSON.stringify({ userId: user.id }) });

      while (open) {
        await stream.sleep(heartbeatMs);
        if (!open) break;
        const [valid] = await sql`
          SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = ${sessionId} AND s.expires_at > now() AND u.is_active`;
        if (!valid) {
          await stream.writeSSE({ event: 'signed_out', data: '{}' });
          break;
        }
        await stream.write(': keep-alive\n\n');
      }
      open = false;
      events.off('event', send);
    });
  });

  return app;
}
