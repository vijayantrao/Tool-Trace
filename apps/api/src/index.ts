import { serve } from '@hono/node-server';
import type { MqttClient } from 'mqtt';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { FloorEvents } from './stations/floor-events.js';
import { StationGateway } from './stations/gateway.js';
import { connectGateway, startDevBroker } from './stations/mqtt.js';

const config = loadConfig();
const sql = createDb(config.DATABASE_URL);
const events = await new FloorEvents(sql).start();
const gateway = new StationGateway(sql, config);
const app = createApp({ sql, config, gateway, events });

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
}, 10 * 60_000);
sweep.unref();

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`[api] ToolTrace API listening on :${info.port} (${config.NODE_ENV})`);
});

const shutdown = async () => {
  server.close();
  await mqttClient?.endAsync().catch(() => {});
  await stopBroker?.().catch(() => {});
  await events.stop().catch(() => {});
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
