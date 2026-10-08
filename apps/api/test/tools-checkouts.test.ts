import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, inDays, isoDay, signUp, type Harness } from './helpers/harness.js';

let h: Harness;
let sk: Awaited<ReturnType<typeof signUp>>;
let tech: Awaited<ReturnType<typeof signUp>>;
let locationId: string;

beforeAll(async () => {
  h = await createHarness();
  sk = await signUp(h, 'storekeeper');
  tech = await signUp(h, 'technician');
  locationId = (await sk.client.post('/api/locations', { name: 'Main Crib', kind: 'crib' })).body.location.id;
});
afterAll(async () => {
  await h.close();
});

const calibratedTool = (tag: string, lastCalibratedDaysAgo: number, interval = 180) => ({
  assetTag: tag,
  name: `Torque Wrench ${tag}`,
  category: 'Torque',
  homeLocationId: locationId,
  requiresCalibration: true,
  calibrationIntervalDays: interval,
  lastCalibratedOn: isoDay(-lastCalibratedDaysAgo),
});

describe('tool registry', () => {
  it('computes calibration due date and state', async () => {
    const ok = await sk.client.post('/api/tools', calibratedTool('TW-1001', 10));
    expect(ok.status).toBe(201);
    expect(ok.body.tool).toMatchObject({ calibrationState: 'ok', calibrationDueOn: isoDay(170), status: 'available' });

    const soon = await sk.client.post('/api/tools', calibratedTool('TW-1002', 175));
    expect(soon.body.tool.calibrationState).toBe('due_soon');

    const expired = await sk.client.post('/api/tools', calibratedTool('TW-1003', 200));
    expect(expired.body.tool.calibrationState).toBe('expired');

    const plain = await sk.client.post('/api/tools', {
      assetTag: 'CR-2001',
      name: 'Crimper',
      category: 'Electrical',
      homeLocationId: locationId,
    });
    expect(plain.body.tool.calibrationState).toBe('not_required');
  });

  it('validates asset tags and calibration fields', async () => {
    const lower = await sk.client.post('/api/tools', { ...calibratedTool('tw-bad', 1), assetTag: 'tw-bad' });
    expect(lower.status).toBe(422);
    const missing = await sk.client.post('/api/tools', {
      assetTag: 'TW-9999',
      name: 'x',
      category: 'y',
      homeLocationId: locationId,
      requiresCalibration: true,
    });
    expect(missing.status).toBe(422);
  });

  it('rejects duplicate asset tags', async () => {
    const dup = await sk.client.post('/api/tools', calibratedTool('TW-1001', 1));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('already_exists');
  });

  it('filters by calibration state and finds tools by tag (for QR scanning)', async () => {
    const expired = await tech.client.get('/api/tools?calibration=expired');
    expect(expired.body.tools.map((t: { assetTag: string }) => t.assetTag)).toEqual(['TW-1003']);
    const byTag = await tech.client.get('/api/tools/by-tag/TW-1001');
    expect(byTag.status).toBe(200);
    expect(byTag.body.tool.openCheckout).toBeNull();
    const search = await tech.client.get('/api/tools?q=crimp');
    expect(search.body.tools).toHaveLength(1);
  });
});

describe('checkout rules', () => {
  it('checks a tool out and marks it unavailable', async () => {
    const res = await tech.client.post('/api/checkouts', { assetTag: 'TW-1001', dueBackAt: inDays(1) });
    expect(res.status).toBe(201);
    const tool = await tech.client.get('/api/tools/by-tag/TW-1001');
    expect(tool.body.tool.status).toBe('checked_out');
    expect(tool.body.tool.openCheckout.holderId).toBe(tech.user.id);
  });

  it('refuses a second checkout of the same tool', async () => {
    const res = await sk.client.post('/api/checkouts', { assetTag: 'TW-1001', dueBackAt: inDays(1) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('tool_unavailable');
  });

  it('locks out tools whose calibration has expired', async () => {
    const res = await tech.client.post('/api/checkouts', { assetTag: 'TW-1003', dueBackAt: inDays(1) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('calibration_expired');
  });

  it('enforces the lockout inside the database even if the API is bypassed', async () => {
    const [tool] = await h.sql`SELECT id FROM tools WHERE asset_tag = 'TW-1003'`;
    await expect(
      h.sql`INSERT INTO checkouts (tool_id, holder_id, issued_by, due_back_at)
            VALUES (${tool!.id}, ${tech.user.id}, ${tech.user.id}, now() + interval '1 day')`,
    ).rejects.toMatchObject({ hint: 'calibration_expired' });
  });

  it('allows only one winner when two people check out the same tool at the same instant', async () => {
    const [a, b] = await Promise.all([
      tech.client.post('/api/checkouts', { assetTag: 'CR-2001', dueBackAt: inDays(1) }),
      sk.client.post('/api/checkouts', { assetTag: 'CR-2001', dueBackAt: inDays(1) }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const [{ n }] = (await h.sql`
      SELECT count(*)::int AS n FROM checkouts c JOIN tools t ON t.id = c.tool_id
      WHERE t.asset_tag = 'CR-2001' AND c.returned_at IS NULL`) as unknown as [{ n: number }];
    expect(n).toBe(1);
  });

  it('rejects due dates in the past or too far ahead', async () => {
    expect((await sk.client.post('/api/checkouts', { assetTag: 'TW-1002', dueBackAt: inDays(-1) })).status).toBe(409);
    expect((await sk.client.post('/api/checkouts', { assetTag: 'TW-1002', dueBackAt: inDays(45) })).status).toBe(409);
  });

  it('reports overdue checkouts', async () => {
    await h.sql`
      UPDATE checkouts SET checked_out_at = now() - interval '3 days', due_back_at = now() - interval '1 day'
      WHERE tool_id = (SELECT id FROM tools WHERE asset_tag = 'TW-1001')`;
    const res = await sk.client.get('/api/checkouts?overdue=true');
    expect(res.body.checkouts.map((c: { assetTag: string }) => c.assetTag)).toEqual(['TW-1001']);
    expect(res.body.checkouts[0].overdue).toBe(true);
  });
});

describe('returns and calibration', () => {
  it('quarantines a tool returned damaged, and a fresh calibration releases it', async () => {
    const [open] = await h.sql`
      SELECT c.id FROM checkouts c JOIN tools t ON t.id = c.tool_id
      WHERE t.asset_tag = 'TW-1001' AND c.returned_at IS NULL`;
    const ret = await sk.client.post(`/api/checkouts/${open!.id}/return`, { condition: 'damaged', notes: 'Ratchet slipping' });
    expect(ret.status).toBe(200);

    let tool = (await sk.client.get('/api/tools/by-tag/TW-1001')).body.tool;
    expect(tool.status).toBe('quarantined');
    expect((await tech.client.post('/api/checkouts', { assetTag: 'TW-1001', dueBackAt: inDays(1) })).status).toBe(409);

    const again = await sk.client.post(`/api/checkouts/${open!.id}/return`, { condition: 'ok' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_returned');

    const cal = await sk.client.post(`/api/tools/${tool.id}/calibrations`, {
      calibratedOn: isoDay(0),
      performedBy: 'External Calibration Lab',
      certificateRef: 'CAL-2026-0042',
    });
    expect(cal.status).toBe(201);
    tool = cal.body.tool;
    expect(tool.status).toBe('available');
    expect(tool.calibrationDueOn).toBe(isoDay(180));
    expect(tool.calibrations[0].certificateRef).toBe('CAL-2026-0042');
  });

  it('recalibrating an expired tool lifts the lockout', async () => {
    const tool = (await sk.client.get('/api/tools/by-tag/TW-1003')).body.tool;
    expect(
      (await sk.client.post(`/api/tools/${tool.id}/calibrations`, { calibratedOn: isoDay(1), performedBy: 'Lab' })).status,
    ).toBe(409); // future date refused
    await sk.client.post(`/api/tools/${tool.id}/calibrations`, { calibratedOn: isoDay(0), performedBy: 'Lab' });
    expect((await tech.client.post('/api/checkouts', { assetTag: 'TW-1003', dueBackAt: inDays(1) })).status).toBe(201);
  });

  it('cannot retire a tool that is checked out', async () => {
    const tool = (await sk.client.get('/api/tools/by-tag/TW-1003')).body.tool;
    const res = await sk.client.patch(`/api/tools/${tool.id}`, { status: 'retired' });
    expect(res.status).toBe(409);
  });
});
