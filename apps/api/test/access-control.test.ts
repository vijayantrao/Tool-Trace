import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, inDays, signUp, type Harness } from './helpers/harness.js';

let h: Harness;
let admin: Awaited<ReturnType<typeof signUp>>;
let storekeeper: Awaited<ReturnType<typeof signUp>>;
let technician: Awaited<ReturnType<typeof signUp>>;
let auditor: Awaited<ReturnType<typeof signUp>>;
let locationId: string;

beforeAll(async () => {
  h = await createHarness();
  admin = await signUp(h, 'admin');
  storekeeper = await signUp(h, 'storekeeper');
  technician = await signUp(h, 'technician');
  auditor = await signUp(h, 'auditor');
  const loc = await storekeeper.client.post('/api/locations', { name: 'Crib A', kind: 'crib' });
  locationId = loc.body.location.id;
});
afterAll(async () => {
  await h.close();
});

const newTool = (tag: string) => ({ assetTag: tag, name: `Tool ${tag}`, category: 'Hand', homeLocationId: locationId });

describe('authentication is required everywhere', () => {
  it.each(['/api/tools', '/api/checkouts', '/api/locations', '/api/users', '/api/auth/me'])('%s -> 401', async (path) => {
    const res = await h.client().get(path);
    expect(res.status).toBe(401);
  });
});

describe('role-based access control', () => {
  it('only admin and storekeeper can register tools', async () => {
    expect((await technician.client.post('/api/tools', newTool('RB-001'))).status).toBe(403);
    expect((await auditor.client.post('/api/tools', newTool('RB-002'))).status).toBe(403);
    expect((await storekeeper.client.post('/api/tools', newTool('RB-003'))).status).toBe(201);
    expect((await admin.client.post('/api/tools', newTool('RB-004'))).status).toBe(201);
  });

  it('only admins can invite people', async () => {
    const body = { email: 'new.person@example.com', role: 'technician' };
    expect((await storekeeper.client.post('/api/invites', body)).status).toBe(403);
    const res = await admin.client.post('/api/invites', body);
    expect(res.status).toBe(201);
    expect(res.body.invite.inviteUrl).toContain('/accept-invite#token=');
    // The raw token is never stored.
    const [row] = await h.sql`SELECT token_hash FROM invites WHERE id = ${res.body.invite.id}`;
    expect(Buffer.from(row!.tokenHash).toString('base64url')).not.toBe(res.body.invite.token);
  });

  it('storekeepers can list people to issue tools to, without seeing emails', async () => {
    const res = await storekeeper.client.get('/api/holders');
    expect(res.status).toBe(200);
    expect(res.body.holders.length).toBeGreaterThan(0);
    expect(res.body.holders.every((u: { role: string }) => u.role !== 'auditor')).toBe(true);
    expect(res.body.holders[0]).not.toHaveProperty('email');
    expect((await technician.client.get('/api/holders')).status).toBe(403);
  });

  it('auditors are read-only', async () => {
    expect((await auditor.client.get('/api/tools')).status).toBe(200);
    expect((await auditor.client.get('/api/users')).status).toBe(200);
    const co = await auditor.client.post('/api/checkouts', { assetTag: 'RB-003', dueBackAt: inDays(1) });
    expect(co.status).toBe(403);
  });

  it('technicians can only check tools out to themselves and only see their own checkouts', async () => {
    const forOther = await technician.client.post('/api/checkouts', {
      assetTag: 'RB-003',
      holderId: storekeeper.user.id,
      dueBackAt: inDays(1),
    });
    expect(forOther.status).toBe(403);

    const own = await technician.client.post('/api/checkouts', { assetTag: 'RB-003', dueBackAt: inDays(1) });
    expect(own.status).toBe(201);
    const other = await storekeeper.client.post('/api/checkouts', {
      assetTag: 'RB-004',
      holderId: storekeeper.user.id,
      dueBackAt: inDays(1),
    });
    expect(other.status).toBe(201);

    // Even when asking for someone else's checkouts, a technician gets only their own.
    const list = await technician.client.get(`/api/checkouts?holderId=${storekeeper.user.id}`);
    expect(list.status).toBe(200);
    expect(list.body.checkouts.every((c: { holderId: string }) => c.holderId === technician.user.id)).toBe(true);
    expect(list.body.checkouts).toHaveLength(1);
  });

  it('only storekeepers or admins can receive returns', async () => {
    const [open] = await h.sql`SELECT id FROM checkouts WHERE holder_id = ${technician.user.id} AND returned_at IS NULL`;
    expect((await technician.client.post(`/api/checkouts/${open!.id}/return`, { condition: 'ok' })).status).toBe(403);
    expect((await storekeeper.client.post(`/api/checkouts/${open!.id}/return`, { condition: 'ok' })).status).toBe(200);
  });
});

describe('admin safety rails', () => {
  it('an admin cannot change their own role or deactivate themselves', async () => {
    const res = await admin.client.patch(`/api/users/${admin.user.id}`, { isActive: false });
    expect(res.status).toBe(403);
  });

  it('two admins demoting each other at the same instant can never leave zero admins', async () => {
    const solo = await createHarness();
    try {
      const a = await signUp(solo, 'admin');
      const b = await signUp(solo, 'admin');
      const [ab, ba] = await Promise.all([
        a.client.patch(`/api/users/${b.user.id}`, { role: 'technician' }),
        b.client.patch(`/api/users/${a.user.id}`, { role: 'technician' }),
      ]);
      // Exactly one wins. The other is refused: either its session was already
      // revoked (401) or the in-transaction re-check sees it is no longer admin (403).
      const statuses = [ab.status, ba.status];
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(statuses.find((s) => s !== 200)).toBeOneOf([401, 403]);
      const [row] = await solo.sql`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND is_active`;
      expect(row!.n).toBe(1);
    } finally {
      await solo.close();
    }
  });

  it('a role change revokes the affected user\'s sessions immediately', async () => {
    const target = await signUp(h, 'storekeeper');
    expect((await target.client.get('/api/auth/me')).status).toBe(200);
    expect((await admin.client.patch(`/api/users/${target.user.id}`, { role: 'auditor' })).status).toBe(200);
    expect((await target.client.get('/api/auth/me')).status).toBe(401);
  });
});

describe('CSRF and request hardening', () => {
  it('blocks state-changing requests from another origin', async () => {
    const res = await storekeeper.client.request('POST', '/api/locations', { name: 'Evil', kind: 'bay' }, {
      origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('bad_origin');
  });

  it('blocks requests the browser marks as cross-site', async () => {
    const res = await storekeeper.client.request('POST', '/api/locations', { name: 'Evil2', kind: 'bay' }, {
      'sec-fetch-site': 'cross-site',
    });
    expect(res.status).toBe(403);
  });

  it('sends strict security headers', async () => {
    const res = await h.client().get('/healthz');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects oversized bodies', async () => {
    const res = await storekeeper.client.post('/api/locations', { name: 'x'.repeat(70_000), kind: 'bay' });
    expect(res.status).toBe(413);
  });

  it('returns a consistent validation error shape', async () => {
    const res = await storekeeper.client.post('/api/locations', { name: '', kind: 'garage' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['kind', 'name']);
  });
});
