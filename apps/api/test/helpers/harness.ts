/**
 * Test harness: a fresh, fully migrated Postgres database per test file,
 * the real app, and a cookie-keeping HTTP client.
 */
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { createApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Sql } from '../../src/db.js';
import { migrate } from '../../src/migrate.js';
import { createInvite } from '../../src/services/invites.js';
import { FloorEvents } from '../../src/stations/floor-events.js';
import { StationGateway } from '../../src/stations/gateway.js';
import type { Role } from '../../src/types.js';
import { SoftAuthenticator } from './authenticator.js';

export const ORIGIN = 'http://localhost:3000';
export const TEST_MASTER_KEY = 'f'.repeat(64);
export const RP_ID = 'localhost';

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';

export async function createHarness(overrides: Partial<Record<string, string>> = {}) {
  const dbName = `tt_test_${randomBytes(6).toString('hex')}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${dbName}`);

  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  const sql = createDb(url.toString(), { max: 10 });
  await migrate(sql);

  const config: Config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: url.toString(),
    APP_URL: ORIGIN,
    RP_ID,
    RP_ORIGINS: ORIGIN,
    COOKIE_SECURE: 'false',
    AUTH_RATE_LIMIT_PER_MINUTE: '1000',
    STATION_MASTER_KEY: TEST_MASTER_KEY,
    ...overrides,
  });
  const events = await new FloorEvents(sql).start();
  // Tests fire taps far faster than people; the real limits are tested separately.
  const gateway = new StationGateway(sql, config, { burst: 1000, perSecond: 1000 });
  const app = createApp({ sql, config, events, gateway, sseHeartbeatMs: 300 });

  return {
    sql,
    config,
    app,
    events,
    gateway,
    client: () => new TestClient(app),
    async close() {
      await events.stop();
      await sql.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    },
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

type AppLike = ReturnType<typeof createApp>;

export class TestClient {
  cookies = new Map<string, string>();
  constructor(private readonly app: AppLike) {}

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { origin: ORIGIN, ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');

    const res = await this.app.request(path, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const [name, ...rest] = pair!.split('=');
      const value = rest.join('=');
      if (!value || /max-age=0/i.test(line)) this.cookies.delete(name!.trim());
      else this.cookies.set(name!.trim(), value);
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    return { status: res.status, body: json, headers: res.headers, raw: res };
  }

  get = (path: string) => this.request('GET', path);
  post = (path: string, body?: unknown) => this.request('POST', path, body ?? {});
  patch = (path: string, body: unknown) => this.request('PATCH', path, body);
  delete = (path: string) => this.request('DELETE', path);
}

/** Full real flow: invite -> passkey registration -> signed-in client. */
export async function signUp(h: Harness, role: Role, name = `${role} user`) {
  const email = `${role}.${randomBytes(4).toString('hex')}@example.com`;
  const invite = await createInvite(h.sql, h.config, { email, role, createdBy: null });
  const client = h.client();
  const authenticator = new SoftAuthenticator(RP_ID, ORIGIN);

  const opts = await client.post('/api/auth/register/options', { inviteToken: invite.token });
  if (opts.status !== 200) throw new Error(`register/options failed: ${JSON.stringify(opts.body)}`);
  const verify = await client.post('/api/auth/register/verify', {
    displayName: name,
    response: authenticator.create(opts.body),
  });
  if (verify.status !== 201) throw new Error(`register/verify failed: ${JSON.stringify(verify.body)}`);
  return { client, authenticator, user: verify.body.user as { id: string; email: string; role: Role }, invite };
}

export async function signIn(client: TestClient, authenticator: SoftAuthenticator) {
  const opts = await client.post('/api/auth/login/options');
  return client.post('/api/auth/login/verify', { response: authenticator.get(opts.body) });
}

export const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
export const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
