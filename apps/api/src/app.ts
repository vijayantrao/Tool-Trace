import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { ApiError, errorResponse, notFound, toApiError } from './lib/errors.js';
import { originGuard } from './middleware/security.js';
import { loadSession } from './middleware/session.js';
import { authRoutes } from './routes/auth.js';
import { checkoutRoutes } from './routes/checkouts.js';
import { toolRoutes } from './routes/tools.js';
import { userRoutes } from './routes/users.js';
import type { AppEnv, Deps } from './types.js';

export function createApp(deps: Deps) {
  const { sql, config } = deps;
  const app = new Hono<AppEnv>();

  app.use(
    '*',
    secureHeaders({
      // JSON-only API: nothing should ever render, frame, or load from it.
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      strictTransportSecurity: 'max-age=63072000; includeSubDomains',
      referrerPolicy: 'no-referrer',
      crossOriginResourcePolicy: 'same-origin',
    }),
  );
  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use(
    '*',
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => errorResponse(c, new ApiError(413, 'payload_too_large', 'Request body too large')),
    }),
  );
  app.use('*', originGuard(config.RP_ORIGINS));

  app.get('/healthz', async (c) => {
    await sql`SELECT 1`;
    return c.json({ status: 'ok' });
  });

  const api = new Hono<AppEnv>();
  api.use('*', loadSession(sql, config));
  api.route('/auth', authRoutes(deps));
  api.route('/', userRoutes(deps));
  api.route('/', toolRoutes(deps));
  api.route('/', checkoutRoutes(deps));
  app.route('/api', api);

  app.notFound((c) => errorResponse(c, notFound('Route')));
  app.onError((err, c) => {
    const apiError = toApiError(err);
    if (apiError.status >= 500) console.error('[api] unhandled error', err);
    return errorResponse(c, apiError);
  });

  return app;
}
