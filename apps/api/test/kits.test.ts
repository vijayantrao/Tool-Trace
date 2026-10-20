import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, inDays, isoDay, signUp, type Harness } from './helpers/harness.js';

describe('tool kits', () => {
  let h: Harness;
  let admin: Awaited<ReturnType<typeof signUp>>;
  let sk: Awaited<ReturnType<typeof signUp>>;
  let tech: Awaited<ReturnType<typeof signUp>>;
  let other: Awaited<ReturnType<typeof signUp>>;
  let loc: string;
  let kitId: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    h = await createHarness();
    admin = await signUp(h, 'admin');
    sk = await signUp(h, 'storekeeper', 'Ravi Kumar');
    tech = await signUp(h, 'technician', 'Asha Verma');
    other = await signUp(h, 'technician', 'Vikram Singh');
    loc = (await sk.client.post('/api/locations', { name: 'Crib', kind: 'crib' })).body.location.id;
    for (const tag of ['SK-0001', 'SK-0002', 'SK-0003', 'SK-0004']) {
      ids[tag] = (await sk.client.post('/api/tools', { assetTag: tag, name: `Socket ${tag}`, category: 'Hand tools', homeLocationId: loc })).body.tool.id;
    }
    ids['TW-0009'] = (
      await sk.client.post('/api/tools', {
        assetTag: 'TW-0009', name: 'Torque wrench', category: 'Torque', homeLocationId: loc,
        requiresCalibration: true, calibrationIntervalDays: 30, lastCalibratedOn: isoDay(-40),
      })
    ).body.tool.id;
  });
  afterAll(() => h.close());

  it('builds a kit from tools by tag (each tool in one kit only; kit tags never clash with tool tags)', async () => {
    expect((await tech.client.post('/api/kits', { assetTag: 'KIT-0001', name: 'x', homeLocationId: loc })).status).toBe(403);
    const res = await sk.client.post('/api/kits', { assetTag: 'kit-0001', name: 'Socket set 10-13 mm', homeLocationId: loc, toolTags: ['SK-0001', 'SK-0002', 'SK-0003'] });
    expect(res.status).toBe(201);
    kitId = res.body.kit.id;
    expect(res.body.kit).toMatchObject({ assetTag: 'KIT-0001', state: 'in_crib', tools: [{ assetTag: 'SK-0001' }, { assetTag: 'SK-0002' }, { assetTag: 'SK-0003' }] });
    expect((await sk.client.post('/api/kits', { assetTag: 'KIT-0002', name: 'Other', homeLocationId: loc, toolTags: ['SK-0001'] })).body.error)
      .toMatchObject({ code: 'already_in_kit', message: 'SK-0001 is already in kit KIT-0001' });
    expect((await sk.client.post('/api/kits', { assetTag: 'SK-0004', name: 'Clash', homeLocationId: loc })).body.error.code).toBe('tag_in_use');
    expect((await sk.client.post('/api/tools', { assetTag: 'KIT-0001', name: 'Clash', category: 'x', homeLocationId: loc })).body.error.code).toBe('tag_in_use');
    expect((await tech.client.get('/api/kits/by-tag/KIT-0001')).body.kit.id).toBe(kitId);
    expect((await tech.client.get(`/api/tools/${ids['SK-0002']}`)).body.tool.kit).toMatchObject({ assetTag: 'KIT-0001' });
  });

  it('issues the whole kit in one go, only if every piece can go out', async () => {
    await sk.client.post(`/api/kits/${kitId}/tools`, { assetTag: 'TW-0009' }); // expired calibration
    const blocked = await tech.client.post(`/api/kits/${kitId}/checkout`, { dueBackAt: inDays(1) });
    expect(blocked.body.error).toMatchObject({ code: 'kit_incomplete', message: "The kit can't go out: TW-0009 (calibration expired)" });
    expect((await sk.client.get(`/api/tools/${ids['SK-0001']}`)).body.tool.status).toBe('available'); // nothing half-issued
    await sk.client.delete(`/api/kits/${kitId}/tools/${ids['TW-0009']}`);

    expect((await tech.client.post(`/api/kits/${kitId}/checkout`, { holderId: other.user.id, dueBackAt: inDays(1) })).status).toBe(403);
    const res = await sk.client.post(`/api/kits/${kitId}/checkout`, { holderId: tech.user.id, dueBackAt: inDays(1) });
    expect(res.status).toBe(201);
    expect(res.body.kit).toMatchObject({ state: 'out', openIssue: { holderName: 'Asha Verma', ackStatus: 'pending' } });
    expect(res.body.kit.tools.every((t: { status: string; holderName: string }) => t.status === 'checked_out' && t.holderName === 'Asha Verma')).toBe(true);
    // One confirmation for the whole kit, not one per piece.
    expect((await tech.client.get('/api/dashboard')).body.myAcknowledgements).toEqual([
      expect.objectContaining({ subjectType: 'kit_issue', summary: 'kit KIT-0001 Socket set 10-13 mm (3 tools)' }),
    ]);
    expect((await sk.client.get(`/api/tools/${ids['SK-0003']}`)).body.tool.openCheckout.acknowledgement).toMatchObject({ status: 'pending' });
    const audit = (await admin.client.get(`/api/audit?entityId=${kitId}`)).body.entries.map((e: { action: string }) => e.action);
    expect(audit).toContain('kit.issued');
  });

  it('takes it back piece by piece: every piece ticked off, missing ones stay out and the crib is told', async () => {
    const incomplete = await sk.client.post(`/api/kits/${kitId}/return`, { tools: [{ toolId: ids['SK-0001'], condition: 'ok' }] });
    expect(incomplete.body.error).toMatchObject({ code: 'checklist_incomplete', message: 'Tick off every piece: SK-0002, SK-0003' });

    const res = await sk.client.post(`/api/kits/${kitId}/return`, {
      tools: [
        { toolId: ids['SK-0001'], condition: 'ok' },
        { toolId: ids['SK-0002'], condition: 'damaged' },
        { toolId: ids['SK-0003'], condition: 'missing' },
      ],
    });
    expect(res.body).toMatchObject({ returned: 2, missing: ['SK-0003'] });
    expect(res.body.kit.state).toBe('partial');
    const status = async (t: string) => (await sk.client.get(`/api/tools/${ids[t]}`)).body.tool.status;
    expect([await status('SK-0001'), await status('SK-0002'), await status('SK-0003')]).toEqual(['available', 'quarantined', 'checked_out']);
    const told = (await admin.client.get('/api/notifications')).body.notifications[0];
    expect(told).toMatchObject({ kind: 'kit.incomplete_return', title: 'Kit KIT-0001 came back without SK-0003' });
    expect((await tech.client.get('/api/notifications')).body.notifications.some((n: { kind: string }) => n.kind === 'kit.incomplete_return')).toBe(true);

    // The missing piece turns up later.
    expect((await sk.client.post(`/api/kits/${kitId}/return`, { tools: [{ toolId: ids['SK-0003'], condition: 'ok' }] })).body.returned).toBe(1);
    const list = (await tech.client.get('/api/kits')).body.kits;
    expect(list[0]).toMatchObject({ assetTag: 'KIT-0001', toolCount: 3, state: 'unavailable' }); // SK-0002 is in quarantine
    expect((await sk.client.post(`/api/kits/${kitId}/return`, { tools: [{ toolId: ids['SK-0001'], condition: 'ok' }] })).body.error.code).toBe('kit_not_out');
  });
});
