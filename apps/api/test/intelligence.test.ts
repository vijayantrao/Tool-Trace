/**
 * Phase 5: model results in the API, human review of anomalies, and safe
 * replay of actions queued while offline.
 *
 * Model output is written here directly, exactly as the Python job writes it;
 * the job itself is tested in ml/tests.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TxSql } from '../src/db.js';
import { enterAppRole } from '../src/middleware/db.js';
import { createHarness, inDays, signUp, type Harness } from './helpers/harness.js';

let h: Harness;
let admin: Awaited<ReturnType<typeof signUp>>;
let sk: Awaited<ReturnType<typeof signUp>>;
let asha: Awaited<ReturnType<typeof signUp>>;
let ravi: Awaited<ReturnType<typeof signUp>>;
let auditor: Awaited<ReturnType<typeof signUp>>;
const tools: Record<string, string> = {};

async function asApp<T>(actor: { role: string; userId?: string }, fn: (tx: TxSql) => Promise<T>): Promise<T> {
  return h.sql.begin(async (tx) => {
    await enterAppRole(tx, actor, { write: true });
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
const withKey = (client: typeof asha.client, path: string, body: unknown, key: string) =>
  client.request('POST', path, body, { 'idempotency-key': key });

beforeAll(async () => {
  h = await createHarness();
  admin = await signUp(h, 'admin', 'Priya Nair');
  sk = await signUp(h, 'storekeeper', 'Ravi Store');
  asha = await signUp(h, 'technician', 'Asha Verma');
  ravi = await signUp(h, 'technician', 'Ravi Kumar');
  auditor = await signUp(h, 'auditor', 'Audrey');
  const loc = (await sk.client.post('/api/locations', { name: 'Crib', kind: 'crib' })).body.location.id;
  for (const tag of ['INS-0001', 'INS-0002', 'INS-0003', 'OFF-0001', 'OFF-0002', 'OFF-0003', 'OFF-0004']) {
    const res = await sk.client.post('/api/tools', {
      assetTag: tag,
      name: `Tool ${tag}`,
      category: 'Power Tools',
      homeLocationId: loc,
      requiresCalibration: false,
    });
    tools[tag] = res.body.tool.id;
  }
});
afterAll(async () => {
  await h.close();
});

/* ======================================================================== */
describe('insights', () => {
  let scored: string;
  let unscored: string;
  let anomalyId: string;

  beforeAll(async () => {
    scored = (await asha.client.post('/api/checkouts', { assetTag: 'INS-0001', dueBackAt: inDays(1) })).body.checkout.id;
    unscored = (await ravi.client.post('/api/checkouts', { assetTag: 'INS-0002', dueBackAt: inDays(2) })).body.checkout
      .id;
    const odd = (await ravi.client.post('/api/checkouts', { assetTag: 'INS-0003', dueBackAt: inDays(20) })).body.checkout
      .id;

    // What the nightly job writes (it runs as tooltrace_ml; the owner is used here for brevity).
    const [run] = await h.sql<{ id: string }[]>`INSERT INTO ml_runs (model_version) VALUES ('test') RETURNING id`;
    await h.sql`
      UPDATE ml_runs SET status = 'succeeded', finished_at = now(), trained_on = 1000,
        metrics = ${h.sql.json({ late: { model: 'logistic_regression', validationRocAuc: { logistic_regression: 0.85 }, test: { rocAuc: 0.84 } } })}
      WHERE id = ${run!.id}`;
    await h.sql`
      INSERT INTO risk_scores (checkout_id, run_id, late_probability, loss_probability, factors)
      VALUES (${scored}, ${run!.id}, 0.72, 0.31,
              ${h.sql.json([{ key: 'holder_history', text: 'Returned 9 of 12 past check-outs late', impact: 0.2 }])})`;
    const [a] = await h.sql<{ id: string }[]>`
      INSERT INTO anomalies (checkout_id, run_id, score, reasons)
      VALUES (${odd}, ${run!.id}, 0.71,
              ${h.sql.json([{ key: 'log_planned_hours', text: 'Planned for 20 days; most check-outs are 6 h', z: 5.1 }])})
      RETURNING id`;
    anomalyId = a!.id;
  });

  it('shows crib staff which tools are likely late, and why', async () => {
    const res = await sk.client.get('/api/insights');
    expect(res.status).toBe(200);
    expect(res.body.lastSuccessfulRun).toMatchObject({ status: 'succeeded', trainedOn: 1000 });
    // Model output keys come back exactly as the model wrote them.
    expect(res.body.lastSuccessfulRun.metrics.late.validationRocAuc.logistic_regression).toBe(0.85);
    const top = res.body.atRisk[0];
    expect(top).toMatchObject({ checkoutId: scored, assetTag: 'INS-0001', holderName: 'Asha Verma' });
    expect(top.lateProbability).toBeCloseTo(0.72);
    expect(top.factors[0].text).toBe('Returned 9 of 12 past check-outs late');
    // Check-outs made since the last run are listed, just not scored yet.
    expect(res.body.atRisk.find((r: { checkoutId: string }) => r.checkoutId === unscored).lateProbability).toBeNull();
    expect(res.body.anomalies[0]).toMatchObject({ id: anomalyId, status: 'open', assetTag: 'INS-0003' });
    expect(res.body.anomalies[0].reasons[0].key).toBe('log_planned_hours');
  });

  it('puts a summary on the dashboard for staff, and nothing for technicians', async () => {
    expect((await sk.client.get('/api/dashboard')).body.insights).toEqual({
      likelyLate: 1,
      lossRisk: 1,
      openAnomalies: 1,
    });
    expect((await asha.client.get('/api/dashboard')).body.insights).toBeNull();
  });

  it('never shows technicians scores about anyone, themselves included', async () => {
    expect((await asha.client.get('/api/insights')).status).toBe(403);
    // Even a buggy route can't leak them: the database returns no rows.
    const rows = await asApp({ role: 'technician', userId: asha.user.id }, (tx) =>
      Promise.all([tx`SELECT * FROM risk_scores`, tx`SELECT * FROM anomalies`, tx`SELECT * FROM ml_runs`]),
    );
    expect(rows.map((r) => r.length)).toEqual([0, 0, 0]);
    expect((await auditor.client.get('/api/insights')).status).toBe(200);
  });

  it('lets crib staff review a flag, and records who decided what', async () => {
    expect((await auditor.client.post(`/api/anomalies/${anomalyId}/review`, { status: 'dismissed' })).status).toBe(403);
    expect((await asha.client.post(`/api/anomalies/${anomalyId}/review`, { status: 'dismissed' })).status).toBe(403);

    const res = await sk.client.post(`/api/anomalies/${anomalyId}/review`, {
      status: 'dismissed',
      note: 'Planned rebuild, approved by the shift lead',
    });
    expect(res.status).toBe(200);
    expect(res.body.anomaly.status).toBe('dismissed');

    const audit = await admin.client.get('/api/audit?action=anomaly.reviewed');
    expect(audit.body.entries[0]).toMatchObject({
      actorUserId: sk.user.id,
      details: { status: 'dismissed', note: 'Planned rebuild, approved by the shift lead' },
    });
    expect((await sk.client.get('/api/dashboard')).body.insights.openAnomalies).toBe(0);
  });

  it('a reviewer cannot sign a review in someone else’s name', async () => {
    const spoof = asApp({ role: 'storekeeper', userId: sk.user.id }, (tx) =>
      tx`UPDATE anomalies SET status = 'confirmed', reviewed_by = ${admin.user.id}, reviewed_at = now()
         WHERE id = ${anomalyId}`,
    );
    expect(await code(spoof)).toBe('42501');
  });

  it('records every model run in the audit trail', async () => {
    const res = await auditor.client.get('/api/audit?action=ml.');
    expect(res.body.entries.map((e: { action: string }) => e.action)).toContain('ml.run_completed');
    expect((await auditor.client.get('/api/audit?action=anomaly.flagged')).body.entries).toHaveLength(1);
  });
});

/* ======================================================================== */
describe('offline actions replayed with idempotency keys', () => {
  it('a replayed check-out happens once and gets the same answer', async () => {
    const key = randomUUID();
    const body = { assetTag: 'OFF-0001', dueBackAt: inDays(1) };
    const first = await withKey(asha.client, '/api/checkouts', body, key);
    expect(first.status).toBe(201);
    const again = await withKey(asha.client, '/api/checkouts', body, key);
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(again.body.checkout.id).toBe(first.body.checkout.id);
    const rows = await h.sql`SELECT 1 FROM checkouts WHERE tool_id = ${tools['OFF-0001']!}`;
    expect(rows).toHaveLength(1);
  });

  it('simultaneous duplicates (a flaky network retrying) still happen once', async () => {
    const key = randomUUID();
    const body = { assetTag: 'OFF-0002', dueBackAt: inDays(1) };
    const results = await Promise.all([1, 2, 3].map(() => withKey(asha.client, '/api/checkouts', body, key)));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(new Set(results.map((r) => r.body.checkout.id)).size).toBe(1);
    const audited = await h.sql`
      SELECT 1 FROM audit_log WHERE action = 'tool.checked_out' AND entity_id = ${tools['OFF-0002']!}`;
    expect(audited).toHaveLength(1);
  });

  it('refuses to reuse a key for a different request', async () => {
    const key = randomUUID();
    await withKey(asha.client, '/api/checkouts', { assetTag: 'OFF-0003', dueBackAt: inDays(1) }, key);
    const other = await withKey(asha.client, '/api/checkouts', { assetTag: 'OFF-0004', dueBackAt: inDays(1) }, key);
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('idempotency_key_reused');
  });

  it('rejects keys that are not UUIDs', async () => {
    const res = await withKey(asha.client, '/api/checkouts', { assetTag: 'OFF-0004', dueBackAt: inDays(1) }, 'abc');
    expect(res.status).toBe(400);
  });

  it('does not remember failures: a retry after the problem is fixed goes through', async () => {
    const key = randomUUID();
    const body = { assetTag: 'OFF-0001', dueBackAt: inDays(1) }; // Asha still has it
    const busy = await withKey(ravi.client, '/api/checkouts', body, key);
    expect(busy.status).toBe(409);
    const open = (await sk.client.get(`/api/checkouts?open=true`)).body.checkouts.find(
      (c: { assetTag: string }) => c.assetTag === 'OFF-0001',
    );
    await sk.client.post(`/api/checkouts/${open.id}/return`, { condition: 'ok' });
    const retry = await withKey(ravi.client, '/api/checkouts', body, key);
    expect(retry.status).toBe(201);
    expect(retry.headers.get('idempotent-replayed')).toBeNull();
  });

  it('keys belong to one person: the same key from someone else is a different request', async () => {
    const key = randomUUID();
    const a = await withKey(asha.client, '/api/checkouts', { assetTag: 'OFF-0004', dueBackAt: inDays(1) }, key);
    expect(a.status).toBe(201);
    const r = await withKey(ravi.client, '/api/checkouts', { assetTag: 'OFF-0004', dueBackAt: inDays(1) }, key);
    expect(r.status).toBe(409); // evaluated on its own: the tool is now out
    const seen = await asApp({ role: 'technician', userId: ravi.user.id }, (tx) => tx`SELECT * FROM idempotency_keys`);
    expect(seen.every((k) => k.userId === ravi.user.id)).toBe(true);
  });

  it('a replayed return is answered, not refused as "already returned"', async () => {
    const open = (await sk.client.get(`/api/checkouts?open=true`)).body.checkouts.find(
      (c: { assetTag: string }) => c.assetTag === 'OFF-0003',
    );
    const key = randomUUID();
    const first = await withKey(sk.client, `/api/checkouts/${open.id}/return`, { condition: 'ok' }, key);
    const again = await withKey(sk.client, `/api/checkouts/${open.id}/return`, { condition: 'ok' }, key);
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(again.body).toEqual(first.body);
  });

  it('records when an offline check-out really happened, within limits', async () => {
    const queuedAt = new Date(Date.now() - 40 * 60_000).toISOString();
    const res = await withKey(
      asha.client,
      '/api/checkouts',
      { assetTag: 'OFF-0003', dueBackAt: inDays(1), queuedAt },
      randomUUID(),
    );
    expect(res.status).toBe(201);
    const [row] = await h.sql<{ offlineQueuedAt: Date }[]>`
      SELECT offline_queued_at FROM checkouts WHERE id = ${res.body.checkout.id}`;
    expect(row!.offlineQueuedAt.toISOString()).toBe(queuedAt);
    const audit = await admin.client.get(`/api/audit?action=tool.checked_out&entityId=${tools['OFF-0003']!}`);
    expect(audit.body.entries[0].details.offlineQueuedAt).toBeTruthy();

    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    const stale = new Date(Date.now() - 25 * 3_600_000).toISOString();
    for (const q of [future, stale]) {
      const bad = await asha.client.post('/api/checkouts', { assetTag: 'INS-0002', dueBackAt: inDays(1), queuedAt: q });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('invalid_queued_at');
    }
  });
});
