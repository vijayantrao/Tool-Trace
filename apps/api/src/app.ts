import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { ApiError, errorResponse, notFound, toApiError } from './lib/errors.js';
import { MemoryStore, rateLimit } from './lib/rate-limit.js';
import { originGuard } from './middleware/security.js';
import { requestTransaction } from './middleware/db.js';
import { idempotency } from './middleware/idempotency.js';
import { loadSession } from './middleware/session.js';
import { auditRoutes } from './routes/audit.js';
import { authRoutes } from './routes/auth.js';
import { checkoutRoutes } from './routes/checkouts.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { eventRoutes } from './routes/events.js';
import { insightRoutes } from './routes/insights.js';
import { stationRoutes } from './routes/stations.js';
import { toolRoutes } from './routes/tools.js';
import { userRoutes } from './routes/users.js';
import { StationGateway } from './stations/gateway.js';
import type { AppEnv, Deps } from './types.js';

export function createApp(
  input: Omit<Deps, 'gateway' | 'limiter'> & {
    gateway?: Deps['gateway'];
    limiter?: Deps['limiter'];
    sseHeartbeatMs?: number;
  },
) {
  const deps: Deps = {
    ...input,
    gateway: input.gateway ?? new StationGateway(input.sql, input.config),
    limiter: input.limiter ?? new MemoryStore(),
  };
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

  // Deployed behind the web app's proxy: refuse direct calls from the internet. This also makes
  // the client IP in X-Forwarded-For trustworthy (only the proxy can set it).
  if (config.PROXY_SECRET) {
    const expected = Buffer.from(config.PROXY_SECRET);
    app.use('/api/*', async (c, next) => {
      const got = Buffer.from(c.req.header('x-tooltrace-proxy') ?? '');
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
        return errorResponse(c, new ApiError(403, 'direct_access_forbidden', 'Use the ToolTrace web app.'));
      }
      await next();
    });
  }

  app.get('/healthz', async (c) => {
    await sql`SELECT 1`;
    return c.json({ status: 'ok' });
  });

  const api = new Hono<AppEnv>();
  api.use('*', loadSession(sql, config));
  // General limit per signed-in person (sign-in itself has its own, stricter, per-IP limit).
  const perUser = rateLimit({
    name: 'api',
    limit: config.API_RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
    store: deps.limiter,
    trustProxy: config.TRUST_PROXY,
    key: (c) => (c as Context<AppEnv>).get('user')?.id ?? 'anonymous',
  });
  api.use('*', (c, next) => (c.get('user') ? perUser(c, next) : next()));
  // Every data route runs in its own transaction as the restricted role, with
  // row-level security and the audit trail seeing who is acting. Sign-in
  // (no identity yet) and the long-lived event stream are the exceptions.
  const inTransaction = requestTransaction(sql, config.TRUST_PROXY);
  // Public facts the sign-in page needs before anyone is signed in (and a cheap way to wake a sleeping server).
  api.get('/meta', (c) => c.json({ name: config.RP_NAME, demo: config.DEMO_MODE }));

  const outsideTransactions = (path: string) =>
    path.startsWith('/api/auth/') || path === '/api/events' || path === '/api/meta';
  api.use('*', (c, next) => (outsideTransactions(c.req.path) ? next() : inTransaction(c, next)));
  // Offline replays: an action sent again with the same Idempotency-Key happens only once.
  const once = idempotency();
  api.use('*', (c, next) => (outsideTransactions(c.req.path) ? next() : once(c, next)));
  api.route('/auth', authRoutes(deps));
  api.route('/', userRoutes(deps));
  api.route('/', toolRoutes(deps));
  api.route('/', checkoutRoutes(deps));
  api.route('/', dashboardRoutes(deps));
  api.route('/', stationRoutes(deps));
  api.route('/', auditRoutes(deps));
  api.route('/', insightRoutes(deps));
  api.route('/', eventRoutes(deps, input.sseHeartbeatMs));
  app.route('/api', api);

  app.notFound((c) => errorResponse(c, notFound('Route')));
  app.onError((err, c) => {
    const apiError = toApiError(err);
    if (apiError.status >= 500) console.error('[api] unhandled error', err);
    return errorResponse(c, apiError);
  });

  return app;
}
