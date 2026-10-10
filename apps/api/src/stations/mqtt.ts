import { randomBytes } from 'node:crypto';
import mqtt, { type MqttClient } from 'mqtt';
import type { Config } from '../config.js';
import type { StationGateway } from './gateway.js';

/**
 * Connects the gateway to the broker. QoS 1 with a persistent session, so taps
 * published while the API was asleep or restarting are delivered when it returns.
 */
export async function connectGateway(gateway: StationGateway, config: Config, url: string): Promise<MqttClient> {
  const client = await mqtt.connectAsync(url, {
    clientId: process.env.MQTT_CLIENT_ID ?? `tooltrace-api-${randomBytes(4).toString('hex')}`,
    clean: !process.env.MQTT_CLIENT_ID,
    username: config.MQTT_USERNAME,
    password: config.MQTT_PASSWORD,
    reconnectPeriod: 3000,
    connectTimeout: 10_000,
  });
  // Replies go through this client; the gateway itself has no MQTT knowledge.
  gateway.publish = async (t, p) => {
    await client.publishAsync(t, p, { qos: 1 });
  };
  client.on('message', (topic, payload) => {
    void gateway.handleMessage(topic, payload);
  });
  client.on('error', (err) => console.error('[stations] MQTT error:', err.message));
  await client.subscribeAsync(gateway.subscription(), { qos: 1 });
  console.log(`[stations] listening on ${gateway.subscription()}`);
  return client;
}

/** Development convenience: a tiny in-process MQTT broker, so no extra software is needed locally. */
export async function startDevBroker(port: number): Promise<() => Promise<void>> {
  const { Aedes } = await import('aedes');
  const net = await import('node:net');
  const broker = await Aedes.createBroker();
  const server = net.createServer(broker.handle as (s: import('node:net').Socket) => void);
  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.log(`[stations] development MQTT broker on mqtt://localhost:${port}`);
  return () =>
    new Promise<void>((resolve) => {
      server.close(() => broker.close(() => resolve()));
    });
}
