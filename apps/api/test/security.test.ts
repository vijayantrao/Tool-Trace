/**
 * Phase 4 hardening, tested by attacking it.
 *
 * Most tests here bypass the API's own checks and talk to PostgreSQL as the
 * restricted app role, the way a buggy or compromised route would, and show
 * that the database still refuses.
 */
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TxSql } from '../src/db.js';
import { MemoryStore, RedisStore, rateLimit, type LimiterStore } from '../src/lib/rate-limit.js';
import { db, enterAppRole, requestTransaction } from '../src/middleware/db.js';
import type { AppEnv } from '../src/types.js';
import { SoftAuthenticator } from './helpers/authenticator.js';
import { createHarness, inDays, isoDay, ORIGIN, RP_ID, signUp, type Harness } from './helpers/harness.js';

let h: Harness;
let admin: Awaited<ReturnType<typeof signUp>>;
let sk: Awaited<ReturnType<typeof signUp>>;
let asha: Awaited<ReturnType<typeof signUp>>;
let ravi: Awaited<ReturnType<typeof signUp>>;
let auditor: Awaited<ReturnType<typeof signUp>>;
let toolId: string;
let otherToolId: string;
let locationId: string;

/** Runs SQL exactly as a route would: in a transaction, as tooltrace_app, with this actor. */
async function asApp<T>(
  actor: { role: string; userId?: string; stationId?: string },
  fn: (tx: TxSql) => Promise<T>,
  write = true,
): Promise<T> {
  return h.sql.begin(write ? 'read write' : 'read only', async (tx) => {
    await enterAppRole(tx, actor, { write });
    return fn(tx);
  }) as Promise<T>;
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { code?: string }).code ?? 'error';
  }
};

beforeAll(async () => {
  h = await createHarness();
  admin = await signUp(h, 'admin', 'Priya Nair');
  sk = await signUp(h, 'storekeeper', 'Ravi Store');
  asha = await signUp(h, 'technician', 'Asha Verma');
  ravi = await signUp(h, 'technician', 'Ravi Kumar');
  auditor = await signUp(h, 'auditor', 'Audrey');
  locationId = (await sk.client.post('/api/locations', { name: 'Crib', kind: 'crib' })).body.location.id;
  const mk = async (tag: string) =>
    (
      await sk.client.post('/api/tools', {
        assetTag: tag,
        name: `Wrench ${tag}`,
        category: 'Torque',
        homeLocationId: locationId,
        requiresCalibration: true,
        calibrationIntervalDays: 180,
        lastCalibratedOn: isoDay(-5),
      })
    ).body.tool.id as string;
  toolId = await mk('SEC-0001');
  otherToolId = await mk('SEC-0002');
});
afterAll(async () => {
  await h.close();
});

/* ======================================================================== */
describe('least-privilege database role', () => {
  it('cannot read passkeys or WebAuthn challenges at all', async () => {
    expect(await code(asApp({ role: 'admin', userId: admin.user.id }, (tx) => tx`SELECT * FROM passkeys`))).toBe('42501');
    expect(await code(asApp({ role: 'admin', userId: admin.user.id }, (tx) => tx`SELECT * FROM webauthn_challenges`))).toBe('42501');
  });

  it('cannot read session tokens, even as admin', async () => {
    expect(await code(asApp({ role: 'admin', userId: admin.user.id }, (tx) => tx`SELECT token_hash FROM sessions`))).toBe('42501');
  });

  it('cannot change columns it has no business changing (an email, a passkey handle)', async () => {
    const r = await code(asApp({ role: 'admin', userId: admin.user.id }, (tx) => tx`UPDATE users SET email = 'x@evil.example' WHERE id = ${asha.user.id}`));
    expect(r).toBe('42501');
  });

  it('cannot call the audit writer directly to forge entries', async () => {
    const r = await code(asApp({ role: 'admin', userId: admin.user.id }, (tx) => tx`SELECT audit_append('tool.created', 'tool', 'x', '{}')`));
    expect(r).toBe('42501');
  });
});

/* ======================================================================== */
describe('row-level security', () => {
  it('a technician cannot issue a tool to someone else, even bypassing the API', async () => {
    const r = await code(
      asApp({ role: 'technician', userId: asha.user.id }, (tx) => tx`
        INSERT INTO checkouts (tool_id, holder_id, issued_by, due_back_at)
        VALUES (${toolId}, ${ravi.user.id}, ${asha.user.id}, now() + interval '1 day')`),
    );
    expect(r).toBe('42501'); // new row violates row-level security policy
  });

  it('a technician cannot pretend someone else issued the tool', async () => {
    const r = await code(
      asApp({ role: 'technician', userId: asha.user.id }, (tx) => tx`
        INSERT INTO checkouts (tool_id, holder_id, issued_by, due_back_at)
        VALUES (${toolId}, ${asha.user.id}, ${sk.user.id}, now() + interval '1 day')`),
    );
    expect(r).toBe('42501');
  });

  it('a technician cannot edit or retire tools', async () => {
    const rows = await asApp({ role: 'technician', userId: asha.user.id }, (tx) =>
      tx`UPDATE tools SET name = 'pwned', status = 'retired' WHERE id = ${toolId} RETURNING id`,
    );
    expect(rows).toHaveLength(0);
    const [t] = await h.sql`SELECT name, status FROM tools WHERE id = ${toolId}`;
    expect(t).toMatchObject({ name: 'Wrench SEC-0001', status: 'available' });
  });

  it('a technician cannot receive returns', async () => {
    const out = await asha.client.post('/api/checkouts', { toolId, dueBackAt: inDays(1) });
    expect(out.status).toBe(201);
    const rows = await asApp({ role: 'technician', userId: asha.user.id }, (tx) =>
      tx`UPDATE checkouts SET returned_at = now(), received_by = ${asha.user.id}, condition_on_return = 'ok'
         WHERE id = ${out.body.checkout.id} RETURNING id`,
    );
    expect(rows).toHaveLength(0);
    await sk.client.post(`/api/checkouts/${out.body.checkout.id}/return`, { condition: 'ok' });
  });

  it("everyone sees what is out now, but past checkouts stay private to the holder", async () => {
    await sk.client.post('/api/checkouts', { toolId: otherToolId, holderId: ravi.user.id, dueBackAt: inDays(1) });
    const seenByAsha = await asApp({ role: 'technician', userId: asha.user.id }, (tx) =>
      tx<{ holderId: string; returnedAt: Date | null }[]>`SELECT holder_id, returned_at FROM checkouts`, false);
    // Asha's own returned checkout + Ravi's open one; not Ravi's history.
    expect(seenByAsha.some((r) => r.holderId === ravi.user.id && r.returnedAt === null)).toBe(true);
    expect(seenByAsha.some((r) => r.holderId === asha.user.id && r.returnedAt !== null)).toBe(true);

    const [open] = await h.sql`SELECT id FROM checkouts WHERE tool_id = ${otherToolId} AND returned_at IS NULL`;
    await sk.client.post(`/api/checkouts/${open!.id}/return`, { condition: 'ok' });
    const after = await asApp({ role: 'technician', userId: asha.user.id }, (tx) =>
      tx<{ holderId: string }[]>`SELECT holder_id FROM checkouts`, false);
    expect(after.some((r) => r.holderId === ravi.user.id)).toBe(false);

    const staff = await asApp({ role: 'storekeeper', userId: sk.user.id }, (tx) =>
      tx<{ holderId: string }[]>`SELECT holder_id FROM checkouts`, false);
    expect(staff.some((r) => r.holderId === ravi.user.id)).toBe(true);
  });

  it('only admins see invites; only admins and auditors see the audit trail', async () => {
    await admin.client.post('/api/invites', { email: 'new@example.com', role: 'technician' });
    const read = (role: string, userId: string, table: 'invites' | 'audit_log') =>
      asApp({ role, userId }, (tx) => tx`SELECT count(*)::int AS n FROM ${tx(table)}`, false).then((r) => r[0]!.n as number);
    expect(await read('storekeeper', sk.user.id, 'invites')).toBe(0);
    expect(await read('admin', admin.user.id, 'invites')).toBeGreaterThan(0);
    expect(await read('storekeeper', sk.user.id, 'audit_log')).toBe(0);
    expect(await read('technician', asha.user.id, 'audit_log')).toBe(0);
    expect(await read('auditor', auditor.user.id, 'audit_log')).toBeGreaterThan(0);
  });

  it('a non-admin cannot change anyone’s role, even bypassing the API', async () => {
    const rows = await asApp({ role: 'storekeeper', userId: sk.user.id }, (tx) =>
      tx`UPDATE users SET role = 'admin' WHERE id = ${sk.user.id} RETURNING id`,
    );
    expect(rows).toHaveLength(0);
  });

  it('a station can only touch its own row and log only its own events', async () => {
    const a = (await admin.client.post('/api/stations', { name: 'Station A', locationId })).body.station.id as string;
    const b = (await admin.client.post('/api/stations', { name: 'Station B', locationId })).body.station.id as string;
    const updated = await asApp({ role: 'station', stationId: a }, (tx) =>
      tx`UPDATE stations SET is_active = false WHERE id = ${b} RETURNING id`,
    );
    expect(updated).toHaveLength(0);
    const r = await code(
      asApp({ role: 'station', stationId: a }, (tx) => tx`
        INSERT INTO station_events (station_id, kind, outcome, code) VALUES (${b}, 'tap', 'accepted', 'checked_out')`),
    );
    expect(r).toBe('42501');
  });

  it('a station can only issue a tool to the person who badged in', async () => {
    const st = (await h.sql`SELECT id FROM stations LIMIT 1`)[0]!.id as string;
    const r = await code(
      asApp({ role: 'station', stationId: st, userId: asha.user.id }, (tx) => tx`
        INSERT INTO checkouts (tool_id, holder_id, issued_by, due_back_at)
        VALUES (${toolId}, ${ravi.user.id}, ${ravi.user.id}, now() + interval '1 day')`),
    );
    expect(r).toBe('42501');
  });
});

/* ======================================================================== */
describe('request transactions', () => {
  function probeApp(store: LimiterStore = new MemoryStore()) {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('user', { id: admin.user.id, email: 'a@b.c', displayName: 'A', role: 'admin' });
      await next();
    });
    app.use('*', rateLimit({ name: 'probe', limit: 1000, windowMs: 60_000, store, trustProxy: false }));
    app.use('*', requestTransaction(h.sql, false));
    app.get('/write-in-get', async (c) => {
      await db(c)`INSERT INTO locations (name, kind) VALUES ('Sneaky', 'bay')`;
      return c.json({ ok: true });
    });
    app.post('/write-then-fail', async (c) => {
      await db(c)`INSERT INTO locations (name, kind) VALUES ('Half-done', 'bay')`;
      return c.json({ error: 'later step failed' }, 422);
    });
    app.onError((err, c) => c.json({ code: (err as { code?: string }).code }, 500));
    return app;
  }

  it('GET requests run read-only: a read endpoint can never write', async () => {
    const res = await probeApp().request('/write-in-get');
    expect(res.status).toBe(500);
    expect(((await res.json()) as { code: string }).code).toBe('25006'); // read_only_sql_transaction
    expect(await h.sql`SELECT 1 FROM locations WHERE name = 'Sneaky'`).toHaveLength(0);
  });

  it('a failed request leaves no half-finished changes behind', async () => {
    const res = await probeApp().request('/write-then-fail', { method: 'POST' });
    expect(res.status).toBe(422);
    expect(await h.sql`SELECT 1 FROM locations WHERE name = 'Half-done'`).toHaveLength(0);
  });
});

/* ======================================================================== */
describe('tamper-evident audit trail', () => {
  it('records who did what, from where, for every kind of change', async () => {
    const res = await auditor.client.get('/api/audit?limit=200');
    expect(res.status).toBe(200);
    const entries = res.body.entries as { action: string; actorUserId: string | null; actorName: string | null }[];
    const actions = new Set(entries.map((e) => e.action));
    for (const a of [
      'user.registered',
      'auth.signed_in',
      'location.created',
      'tool.created',
      'tool.checked_out',
      'tool.returned',
      'invite.created',
      'station.created',
    ]) {
      expect(actions, a).toContain(a);
    }
    const checkout = entries.find((e) => e.action === 'tool.checked_out' && e.actorUserId === asha.user.id);
    expect(checkout?.actorName).toBe('Asha Verma');
    const created = entries.find((e) => e.action === 'tool.created');
    expect(created?.actorUserId).toBe(sk.user.id);
  });

  it('records role changes and badge assignments with before and after values', async () => {
    await admin.client.patch(`/api/users/${ravi.user.id}`, { badgeUid: 'AA:BB:CC:01' });
    const res = await auditor.client.get(`/api/audit?action=user.updated&entityId=${ravi.user.id}`);
    expect(res.body.entries[0].details.changes.badge_uid).toEqual([null, 'AABBCC01']);
    expect(res.body.entries[0].actorUserId).toBe(admin.user.id);
  });

  it('records failed sign-ins with the reason', async () => {
    const stranger = new SoftAuthenticator(RP_ID, ORIGIN);
    stranger.create({
      challenge: 'AAAA',
      rp: { name: 'x', id: RP_ID },
      user: { id: 'dXNlcg', name: 'u', displayName: 'u' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    });
    const client = h.client();
    const opts = await client.post('/api/auth/login/options');
    expect((await client.post('/api/auth/login/verify', { response: stranger.get(opts.body) })).status).toBe(401);
    const res = await auditor.client.get('/api/audit?action=auth.sign_in_failed');
    expect(res.body.entries[0].details.reason).toBe('unknown_credential');
  });

  it('is only readable by admins and auditors', async () => {
    expect((await sk.client.get('/api/audit')).status).toBe(403);
    expect((await asha.client.get('/api/audit/verify')).status).toBe(403);
  });

  it('cannot be changed or deleted, even by the database owner', async () => {
    expect(await code(h.sql`UPDATE audit_log SET action = 'x' WHERE id = 1`)).toBe('P0001');
    expect(await code(h.sql`DELETE FROM audit_log WHERE id = 1`)).toBe('P0001');
    expect(await code(h.sql`TRUNCATE audit_log`)).toBe('P0001');
  });

  it('verifies as intact, with gapless ids, after many concurrent writes', async () => {
    await Promise.all(
      Array.from({ length: 15 }, (_, i) => sk.client.post('/api/locations', { name: `Bay ${100 + i}`, kind: 'bay' })),
    );
    const res = await auditor.client.get('/api/audit/verify');
    expect(res.body).toMatchObject({ ok: true, firstProblem: null });
    const [{ n }] = (await h.sql`SELECT count(*)::int AS n FROM audit_log`) as unknown as [{ n: number }];
    expect(res.body.checked).toBe(n);
    expect(res.body.head.id).toBe(n);
  });
});

/* ======================================================================== */
describe('tamper detection (someone with direct database access)', () => {
  // A fresh database per scenario, because each one damages the log on purpose.
  async function scenario() {
    const t = await createHarness();
    const a = await signUp(t, 'admin');
    for (let i = 0; i < 4; i++) await a.client.post('/api/locations', { name: `L${i}`, kind: 'bay' });
    const verify = async (q = '') => (await a.client.get(`/api/audit/verify${q}`)).body;
    // What an attacker with superuser access would do: switch off the append-only guard.
    const tamper = async (fn: () => Promise<unknown>) => {
      await t.sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update`;
      try {
        await fn();
      } finally {
        await t.sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update`;
      }
    };
    return { t, a, verify, tamper };
  }

  it('spots an edited entry', async () => {
    const { t, verify, tamper } = await scenario();
    try {
      expect((await verify()).ok).toBe(true);
      await tamper(() => t.sql`UPDATE audit_log SET details = '{"name":"Innocent"}' WHERE id = 3`);
      expect(await verify()).toMatchObject({ ok: false, firstProblem: { id: 3, reason: 'content_changed' } });
    } finally {
      await t.close();
    }
  });

  it('spots a deleted entry', async () => {
    const { t, verify, tamper } = await scenario();
    try {
      await tamper(() => t.sql`DELETE FROM audit_log WHERE id = 4`);
      expect(await verify()).toMatchObject({ ok: false, firstProblem: { id: 4, reason: 'missing_entries' } });
    } finally {
      await t.close();
    }
  });

  it('spots a rewritten chain, given an anchor recorded earlier', async () => {
    const { t, verify, tamper } = await scenario();
    try {
      const anchor = (await verify()).head as { id: number; hash: string };
      // A careful attacker edits an entry and recomputes every hash after it.
      await tamper(async () => {
        await t.sql`UPDATE audit_log SET details = '{"name":"Rewritten"}' WHERE id = 2`;
        await t.sql.unsafe(`
          DO $$
          DECLARE r record; prev bytea;
          BEGIN
            FOR r IN SELECT * FROM audit_log ORDER BY id LOOP
              IF r.id = 1 THEN prev := r.hash; CONTINUE; END IF;
              UPDATE audit_log SET prev_hash = prev,
                hash = sha256(prev || convert_to(audit_payload(r.id, r.at, r.actor_user_id, r.actor_station_id,
                       r.actor_ip, r.action, r.entity_type, r.entity_id, r.details), 'UTF8'))
              WHERE id = r.id RETURNING hash INTO prev;
            END LOOP;
          END $$;`);
      });
      // The chain is internally consistent again...
      expect((await verify()).ok).toBe(true);
      // ...but it no longer matches the anchor recorded before the attack.
      const res = await verify(`?anchorId=${anchor.id}&anchorHash=${anchor.hash}`);
      expect(res).toMatchObject({ ok: false, anchorMatches: false });
    } finally {
      await t.close();
    }
  });
});

/* ======================================================================== */
describe('rate limiting', () => {
  it('limits each signed-in person across the whole API', async () => {
    const t = await createHarness({ API_RATE_LIMIT_PER_MINUTE: '5' });
    try {
      const a = await signUp(t, 'admin');
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) statuses.push((await a.client.get('/api/tools')).status);
      expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
    } finally {
      await t.close();
    }
  });

  it('keeps working (fails open) if the limiter store is down', async () => {
    const broken: LimiterStore = { kind: 'redis', hit: async () => Promise.reject(new Error('down')), close: async () => {} };
    const app = new Hono();
    app.use('*', rateLimit({ name: 'x', limit: 1, windowMs: 60_000, store: broken, trustProxy: false }));
    app.get('/', (c) => c.text('ok'));
    expect((await app.request('/')).status).toBe(200);
    expect((await app.request('/')).status).toBe(200);
  });

  const redisUrl = process.env.REDIS_TEST_URL;
  it.skipIf(!redisUrl)('shares counters across API instances through Redis', async () => {
    const one = await RedisStore.connect(redisUrl!);
    const two = await RedisStore.connect(redisUrl!);
    try {
      const key = `test:${Date.now()}`;
      expect((await one.hit(key, 2000)).count).toBe(1);
      expect((await two.hit(key, 2000)).count).toBe(2); // a second instance sees the first one's hits
      const third = await one.hit(key, 2000);
      expect(third.count).toBe(3);
      expect(third.resetMs).toBeGreaterThan(0);
      expect(third.resetMs).toBeLessThanOrEqual(2000);
      await new Promise((r) => setTimeout(r, 2100));
      expect((await two.hit(key, 2000)).count).toBe(1); // window expired
    } finally {
      await one.close();
      await two.close();
    }
  });
});
