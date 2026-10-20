import { serve } from '@hono/node-server';
import type { MqttClient } from 'mqtt';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { isDemoDatabase, resetDemo } from './demo/demo.js';
import { createLimiterStore } from './lib/rate-limit.js';
import { DataSources } from './services/data-sources/sync.js';
import { FloorEvents } from './stations/floor-events.js';
import { StationGateway } from './stations/gateway.js';
import { connectGateway, startDevBroker } from './stations/mqtt.js';

const config = loadConfig();
const sql = createDb(config.DATABASE_URL, { timeZone: config.TOOLTRACE_SITE_TZ });

// Demo mode signs people in without a passkey, so it only ever runs on a demo database.
// An empty database becomes one automatically (resetDemo refuses if it holds real accounts).
if (config.DEMO_MODE && !(await isDemoDatabase(sql))) {
  try {
    await resetDemo(sql);
    console.log('[demo] this empty database is now the public demo database');
  } catch (err) {
    console.error(`[demo] DEMO_MODE refused: ${(err as Error).message}`);
    process.exit(1);
  }
}
if (config.DEMO_MODE) console.warn('[demo] DEMO MODE: one-click personas are enabled. Never use this with real data.');
const events = await new FloorEvents(sql).start();
const gateway = new StationGateway(sql, config);
const limiter = await createLimiterStore(config.REDIS_URL);
const dataSources = new DataSources(sql, config);
const app = createApp({ sql, config, gateway, events, limiter, dataSources });
console.log(`[data-sources] database connections ${dataSources.databases.enabled ? 'on' : `off: ${dataSources.databases.reason}`}`);

// Smart stations: optional. Needs a master key, plus a broker (real, or the built-in dev one).
let stopBroker: (() => Promise<void>) | undefined;
let mqttClient: MqttClient | undefined;
if (gateway.enabled) {
  let url = config.MQTT_URL;
  if (!url && config.DEV_MQTT_BROKER_PORT) {
    stopBroker = await startDevBroker(config.DEV_MQTT_BROKER_PORT);
    url = `mqtt://127.0.0.1:${config.DEV_MQTT_BROKER_PORT}`;
  }
  if (url) {
    mqttClient = await connectGateway(gateway, config, url).catch((err) => {
      console.error(`[stations] could not connect to ${url.replace(/\/\/.*@/, '//***@')}: ${err.message}`);
      return undefined;
    });
  } else {
    console.log('[stations] STATION_MASTER_KEY is set but no MQTT_URL: stations can be provisioned but not connected');
  }
} else {
  console.log('[stations] disabled (set STATION_MASTER_KEY to enable smart stations)');
}

// Housekeeping: drop expired sessions and WebAuthn challenges, trim old station events.
const sweep = setInterval(() => {
  sql`DELETE FROM sessions WHERE expires_at < now()`.catch(() => {});
  sql`DELETE FROM webauthn_challenges WHERE expires_at < now()`.catch(() => {});
  sql`DELETE FROM station_events WHERE received_at < now() - interval '90 days'`.catch(() => {});
  sql`DELETE FROM idempotency_keys WHERE created_at < now() - interval '7 days'`.catch(() => {});
}, 10 * 60_000);
sweep.unref();

// Scheduled imports and copies (hourly/daily data sources).
let syncing = false;
const scheduled = setInterval(() => {
  if (syncing) return;
  syncing = true;
  dataSources
    .runDue()
    .catch((err) => console.error('[data-sources] scheduled sync failed', err))
    .finally(() => (syncing = false));
}, 5 * 60_000);
scheduled.unref();

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`[api] ToolTrace API listening on :${info.port} (${config.NODE_ENV})`);
});

const shutdown = async () => {
  server.close();
  clearInterval(scheduled);
  await mqttClient?.endAsync().catch(() => {});
  await stopBroker?.().catch(() => {});
  await events.stop().catch(() => {});
  await limiter.close();
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
