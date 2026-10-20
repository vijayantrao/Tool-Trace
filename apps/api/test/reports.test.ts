import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, inDays, isoDay, signUp, type Harness } from './helpers/harness.js';

describe('reports and exports', () => {
  let h: Harness;
  let admin: Awaited<ReturnType<typeof signUp>>;
  let sk: Awaited<ReturnType<typeof signUp>>;
  let tech: Awaited<ReturnType<typeof signUp>>;
  let auditor: Awaited<ReturnType<typeof signUp>>;

  beforeAll(async () => {
    h = await createHarness();
    admin = await signUp(h, 'admin');
    sk = await signUp(h, 'storekeeper', 'Ravi Kumar');
    tech = await signUp(h, 'technician', 'Asha Verma');
    auditor = await signUp(h, 'auditor');
    const loc = (await sk.client.post('/api/locations', { name: 'Crib', kind: 'crib' })).body.location.id;
    const add = (b: Record<string, unknown>) => sk.client.post('/api/tools', { homeLocationId: loc, ...b });
    await add({ assetTag: 'TW-0001', name: 'Torque wrench', category: 'Torque', unitPrice: 18000, requiresCalibration: true, calibrationIntervalDays: 180, lastCalibratedOn: isoDay(-170) });
    await add({ assetTag: 'TW-0002', name: 'Torque wrench', category: 'Torque', unitPrice: 9000, requiresCalibration: true, calibrationIntervalDays: 30, lastCalibratedOn: isoDay(-40) });
    const crimper = (await add({ assetTag: 'CR-0001', name: 'Crimper', category: 'Electrical', unitPrice: 1200 })).body.tool.id;
    await add({ assetTag: 'HM-0001', name: 'Hammer', category: 'Hand tools' });
    await sk.client.post('/api/checkouts', { toolId: crimper, holderId: tech.user.id, dueBackAt: inDays(1) });
    await sk.client.post('/api/stock', { code: 'CT-0001', name: 'Cable ties', kind: 'consumable', category: 'Electrical', unit: 'pcs', locationId: loc, reorderLevel: 100, unitPrice: 2, openingQuantity: 80 });
  });
  afterAll(() => h.close());

  it('sums what the crib is worth and where it is', async () => {
    expect((await tech.client.get('/api/reports/summary')).status).toBe(403);
    const s = (await auditor.client.get('/api/reports/summary')).body;
    expect(s.currency).toBe('INR');
    expect(s.tools).toMatchObject({ count: 4, value: 28200, valueOut: 1200, unpriced: 1, out: 1, calibrated: 2 });
    expect(s.byClass).toEqual([
      { class: 'A', count: 1, value: 18000 },
      { class: 'B', count: 1, value: 9000 },
      { class: 'C', count: 1, value: 1200 },
      { class: 'none', count: 1, value: 0 },
    ]);
    expect(s.byCategory[0]).toEqual({ category: 'Torque', count: 2, value: 27000 });
    expect(s.weekly).toHaveLength(12);
    expect(s.weekly[11].checkouts).toBe(1);
    expect(s.calibrationDue).toHaveLength(6);
    expect(s.calibration).toMatchObject({ expired: 1, dueSoon: 1, atLab: 0 });
    expect(s.stock).toEqual({ items: 1, value: 160, low: 1 });
    expect(s.pendingAcks).toBe(1);
  });

  it('exports each register as rows with Excel headers, audit only for admins and auditors', async () => {
    const tools = (await sk.client.get('/api/reports/export/tools')).body;
    expect(tools.title).toBe('Tool register');
    expect(tools.rows).toHaveLength(4);
    expect(tools.rows.find((r: Record<string, unknown>) => r['Asset tag'] === 'CR-0001')).toMatchObject({ Class: 'C', 'Unit price': 1200, With: 'Asha Verma', Status: 'checked_out' });
    const out = (await sk.client.get(`/api/reports/export/checkouts?from=${isoDay(-1)}&to=${isoDay(0)}`)).body.rows;
    expect(out[0]).toMatchObject({ 'Asset tag': 'CR-0001', Holder: 'Asha Verma', 'Issued by': 'Ravi Kumar', Confirmation: 'pending' });
    expect((await sk.client.get(`/api/reports/export/checkouts?from=${isoDay(1)}`)).body.rows).toEqual([]);
    expect((await sk.client.get('/api/reports/export/stock')).body.rows[0]).toMatchObject({ Code: 'CT-0001', 'Reorder now': true, 'Stock value': 160 });
    expect((await sk.client.get('/api/reports/export/audit')).status).toBe(403);
    const audit = (await auditor.client.get('/api/reports/export/audit')).body.rows;
    expect(audit[0]).toHaveProperty('Hash');
    expect((await auditor.client.get('/api/reports/export/nothing')).status).toBe(422);
  });

  it('lists the calibration register for auditors', async () => {
    const reg = (await auditor.client.get('/api/reports/calibration-register')).body;
    expect(reg.tools.map((t: { assetTag: string; calibrationState: string }) => `${t.assetTag} ${t.calibrationState}`)).toEqual([
      'TW-0002 expired', 'TW-0001 due_soon',
    ]);
    expect(reg.today).toBe(isoDay(0));
    void admin;
  });
});
