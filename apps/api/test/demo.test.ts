/**
 * Phase 6: the public demo and the deployed-behind-a-proxy setup.
 *
 * Demo mode signs people in without a passkey, so most of these tests are
 * about where it must NOT work: on a database with real people, against the
 * shared personas, or when switched off.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDemoDatabase, PERSONA_NAMES, resetDemo } from '../src/demo/demo.js';
import { createHarness, inDays, signUp, type Harness } from './helpers/harness.js';

let demo: Harness;
let normal: Harness;

beforeAll(async () => {
  demo = await createHarness({ DEMO_MODE: 'true' });
  normal = await createHarness();
  await resetDemo(demo.sql);
});
afterAll(async () => {
  await demo.close();
  await normal.close();
});

const signInAs = async (persona: string) => {
  const client = demo.client();
  const res = await client.post('/api/auth/demo', { persona });
  return { client, res };
};

describe('public demo', () => {
  it('tells the sign-in page whether this is the demo', async () => {
    expect((await demo.client().get('/api/meta')).body).toEqual({ name: 'ToolTrace', demo: true });
    expect((await normal.client().get('/api/meta')).body).toEqual({ name: 'ToolTrace', demo: false });
  });

  it('signs a visitor in as any of the four personas with one click', async () => {
    for (const persona of PERSONA_NAMES) {
      const { client, res } = await signInAs(persona);
      expect(res.status).toBe(200);
      expect(res.body.user.role).toBe(persona);
      expect((await client.get('/api/auth/me')).body.user.email).toBe(`${persona}@demo.tooltrace.example`);
    }
    const audit = await (await signInAs('auditor')).client.get('/api/audit?action=auth.signed_in&limit=10');
    expect(audit.body.entries.length).toBeGreaterThanOrEqual(4);
  });

  it('gives the technician persona a tool out and an RFID badge, so the demo has something to show', async () => {
    const { client } = await signInAs('technician');
    const dash = await client.get('/api/dashboard');
    expect(dash.body.myCheckouts.map((c: { assetTag: string }) => c.assetTag)).toEqual(['MM-0201']);
    const [asha] = await demo.sql<{ badgeUid: string }[]>`SELECT badge_uid FROM users WHERE email = 'technician@demo.tooltrace.example'`;
    expect(asha!.badgeUid).toBe('C0FFEE99');
  });

  it('rejects unknown personas', async () => {
    expect((await signInAs('superuser')).res.status).toBe(422);
  });

  it('protects the shared personas from visitors (one visitor must not lock out the rest)', async () => {
    const { client } = await signInAs('admin');
    const [sk] = await demo.sql<{ id: string }[]>`SELECT id FROM users WHERE email = 'storekeeper@demo.tooltrace.example'`;
    for (const change of [{ isActive: false }, { role: 'technician' }, { badgeUid: null }]) {
      const res = await client.patch(`/api/users/${sk!.id}`, change);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('demo_protected');
    }
    // Real accounts made in the demo (by invite) can still be managed, to show the feature.
    const guest = await signUp(demo, 'technician', 'Guest');
    expect((await client.patch(`/api/users/${guest.user.id}`, { isActive: false })).status).toBe(200);
  });

  it('the nightly reset wipes everything, signs everyone out, and starts a fresh audit chain', async () => {
    const { client } = await signInAs('storekeeper');
    expect((await client.post('/api/checkouts', { assetTag: 'IW-0701', dueBackAt: inDays(1) })).status).toBe(201);

    await resetDemo(demo.sql);

    expect((await client.get('/api/auth/me')).status).toBe(401);
    const [users] = await demo.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users`;
    expect(users!.n).toBe(4);
    const [first] = await demo.sql<{ id: string; action: string }[]>`SELECT id::int AS id, action FROM audit_log ORDER BY id LIMIT 1`;
    expect(first).toEqual({ id: 1, action: 'demo.reset' });
    const admin = (await signInAs('admin')).client;
    const verify = await admin.get('/api/audit/verify');
    expect(verify.body).toMatchObject({ ok: true, firstProblem: null });
    const out = await admin.get('/api/checkouts?open=true');
    expect(out.body.checkouts.map((c: { assetTag: string }) => c.assetTag)).toEqual(['MM-0201']);
  });

  it('only resets the audit log through the reset: TRUNCATE is still refused otherwise', async () => {
    await expect(demo.sql`TRUNCATE audit_log`).rejects.toMatchObject({ code: 'P0001' });
  });
});

describe('demo mode can never touch real data', () => {
  it('is off unless switched on: no persona sign-in', async () => {
    const res = await normal.client().post('/api/auth/demo', { persona: 'admin' });
    expect(res.status).toBe(404);
  });

  it('refuses to turn a database with real accounts into a demo', async () => {
    await signUp(normal, 'admin', 'Real Admin');
    await expect(resetDemo(normal.sql)).rejects.toThrow(/real account/);
    expect(await isDemoDatabase(normal.sql)).toBe(false);
    const [users] = await normal.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users`;
    expect(users!.n).toBe(1); // untouched
  });
});

describe('deployed behind the web proxy', () => {
  let gated: Harness;
  const secret = 's'.repeat(48);
  beforeAll(async () => {
    gated = await createHarness({ PROXY_SECRET: secret });
  });
  afterAll(async () => {
    await gated.close();
  });

  it('refuses direct calls that do not come through the web app', async () => {
    const res = await gated.client().get('/api/meta');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('direct_access_forbidden');
    const wrong = await gated.client().request('GET', '/api/meta', undefined, { 'x-tooltrace-proxy': 'x'.repeat(48) });
    expect(wrong.status).toBe(403);
  });

  it('answers the proxy, and health checks still work', async () => {
    const res = await gated.client().request('GET', '/api/meta', undefined, { 'x-tooltrace-proxy': secret });
    expect(res.status).toBe(200);
    expect((await gated.app.request('/healthz')).status).toBe(200);
  });

  it('rejects a secret that is too short to be safe', async () => {
    await expect(createHarness({ PROXY_SECRET: 'short' })).rejects.toThrow(/PROXY_SECRET/);
  });
});
