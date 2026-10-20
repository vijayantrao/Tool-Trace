import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { suggestMapping, toPrice } from '../src/services/data-sources/import.js';
import { createHarness, signUp, type Harness } from './helpers/harness.js';

describe('cost and A/B/C class', () => {
  let h: Harness;
  let admin: Awaited<ReturnType<typeof signUp>>;
  let sk: Awaited<ReturnType<typeof signUp>>;
  let tech: Awaited<ReturnType<typeof signUp>>;
  let loc: string;
  const add = (tag: string, extra: Record<string, unknown> = {}) =>
    sk.client.post('/api/tools', { assetTag: tag, name: `Tool ${tag}`, category: 'Torque', homeLocationId: loc, ...extra });

  beforeAll(async () => {
    h = await createHarness();
    admin = await signUp(h, 'admin');
    sk = await signUp(h, 'storekeeper');
    tech = await signUp(h, 'technician');
    loc = (await sk.client.post('/api/locations', { name: 'Crib', kind: 'crib' })).body.location.id;
  });
  afterAll(() => h.close());

  it('classes tools by unit price with the plant rule (A above 15,000; B 2,000 to 15,000; C below 2,000)', async () => {
    const cases: [string, number | undefined, string | null][] = [
      ['ABC-0001', 15000.01, 'A'],
      ['ABC-0002', 15000, 'B'],
      ['ABC-0003', 2000, 'B'],
      ['ABC-0004', 1999.99, 'C'],
      ['ABC-0005', 0, 'C'],
      ['ABC-0006', undefined, null],
    ];
    for (const [tag, unitPrice, cls] of cases) {
      const res = await add(tag, unitPrice === undefined ? {} : { unitPrice, make: 'Norbar', model: 'TTi 100' });
      expect(res.status).toBe(201);
      expect(res.body.tool).toMatchObject({ unitPrice: unitPrice ?? null, abcClass: cls });
    }
    const a = (await tech.client.get('/api/tools?abcClass=A')).body.tools.map((t: { assetTag: string }) => t.assetTag);
    expect(a).toEqual(['ABC-0001']);
    const none = (await tech.client.get('/api/tools?abcClass=none')).body.tools.map((t: { assetTag: string }) => t.assetTag);
    expect(none).toEqual(['ABC-0006']);
    expect((await add('ABC-0007', { unitPrice: -1 })).status).toBe(422);
  });

  it('lets crib staff change price, make and model (recorded in the audit trail), but not technicians', async () => {
    const id = (await sk.client.get('/api/tools/by-tag/ABC-0004')).body.tool.id;
    expect((await tech.client.patch(`/api/tools/${id}`, { unitPrice: 50000 })).status).toBe(403);
    const res = await sk.client.patch(`/api/tools/${id}`, { unitPrice: 25000.456, make: 'Stahlwille', model: null });
    expect(res.body.tool).toMatchObject({ unitPrice: 25000.46, abcClass: 'A', make: 'Stahlwille', model: null });
    // The class follows the price; it can't be set on its own.
    await expect(h.sql`UPDATE tools SET abc_class = 'C' WHERE id = ${id}`).rejects.toThrow(/abc_class/);
    const audit = (await admin.client.get(`/api/audit?action=tool.updated&entityId=${id}`)).body.entries[0];
    expect(audit.details.changes).toMatchObject({ unit_price: [1999.99, 25000.46], make: ['Norbar', 'Stahlwille'], model: ['TTi 100', null] });
  });

  it('imports prices written the way spreadsheets write them', async () => {
    expect(toPrice('₹ 12,500.00')).toBe(12500);
    expect(toPrice('Rs. 1,200')).toBe(1200);
    expect(toPrice('850/-')).toBe(850);
    expect(toPrice(99.999)).toBe(100);
    expect(toPrice('twelve')).toBe('invalid');
    expect(toPrice('')).toBeNull();
    expect(suggestMapping(['Tool No', 'Description', 'Unit Price', 'Make', 'Model No'])).toMatchObject({
      unitPrice: 'Unit Price', make: 'Make', model: 'Model No',
    });

    const res = await admin.client.post('/api/data-sources/files/import', {
      fileName: 'prices.xlsx', fileKind: 'excel', dateOrder: 'dmy', dryRun: false,
      rows: [
        { row: 2, values: { assetTag: 'IMP-0001', name: 'Torque multiplier', unitPrice: '₹ 48,000', make: 'Norbar' } },
        { row: 3, values: { assetTag: 'ABC-0006', name: 'Tool ABC-0006', category: 'Torque', location: 'Crib', unitPrice: 1500 } },
        { row: 4, values: { assetTag: 'IMP-0002', name: 'Bad price', unitPrice: 'call us' } },
      ],
    });
    expect(res.body.result).toMatchObject({ created: 1, updated: 1, skipped: 1 });
    expect(res.body.result.problems[0].message).toMatch(/Unit price "call us"/);
    expect((await sk.client.get('/api/tools/by-tag/IMP-0001')).body.tool).toMatchObject({ unitPrice: 48000, abcClass: 'A', make: 'Norbar' });
    expect((await sk.client.get('/api/tools/by-tag/ABC-0006')).body.tool).toMatchObject({ unitPrice: 1500, abcClass: 'C' });
  });
});
