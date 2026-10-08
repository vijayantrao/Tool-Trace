import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';

const config = loadConfig();
const sql = createDb(config.DATABASE_URL);
const app = createApp({ sql, config });

// Housekeeping: drop expired sessions and WebAuthn challenges every 10 minutes.
const sweep = setInterval(() => {
  sql`DELETE FROM sessions WHERE expires_at < now()`.catch(() => {});
  sql`DELETE FROM webauthn_challenges WHERE expires_at < now()`.catch(() => {});
}, 10 * 60_000);
sweep.unref();

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`[api] ToolTrace API listening on :${info.port} (${config.NODE_ENV})`);
});

const shutdown = () => {
  server.close();
  sql.end({ timeout: 5 }).finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
