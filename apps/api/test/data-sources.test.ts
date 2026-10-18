import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkAddress } from '../src/lib/net-guard.js';
import { SecretBox } from '../src/lib/secret-box.js';
import { suggestMapping, toIntervalDays, toIsoDate } from '../src/services/data-sources/import.js';
import { createHarness, inDays, isoDay, signUp, type Harness } from './helpers/harness.js';

const KEY = 'a1'.repeat(32);

describe('value parsing', () => {
  it('reads dates the way spreadsheets and databases write them', () => {
    expect(toIsoDate('2026-04-15', 'dmy')).toBe('2026-04-15');
    expect(toIsoDate('15/04/2026', 'dmy')).toBe('2026-04-15');
    expect(toIsoDate('04/15/2026', 'mdy')).toBe('2026-04-15');
    expect(toIsoDate('15.04.2026', 'dmy')).toBe('2026-04-15');
    expect(toIsoDate(new Date(Date.UTC(2026, 3, 15)), 'dmy')).toBe('2026-04-15');
    expect(toIsoDate(46127, 'dmy')).toBe('2026-04-15'); // Excel serial day number
    expect(toIsoDate('31/02/2026', 'dmy')).toBe('invalid');
    expect(toIsoDate('next week', 'dmy')).toBe('invalid');
    expect(toIsoDate('', 'dmy')).toBeNull();
  });

  it('reads calibration intervals in days, weeks, months or years', () => {
    expect(toIntervalDays(180)).toBe(180);
    expect(toIntervalDays('180 days')).toBe(180);
    expect(toIntervalDays('6 months')).toBe(180);
    expect(toIntervalDays('1 year')).toBe(365);
    expect(toIntervalDays('2 weeks')).toBe(14);
    expect(toIntervalDays(0)).toBe('invalid');
    expect(toIntervalDays('often')).toBe('invalid');
    expect(toIntervalDays(null)).toBeNull();
  });

  it('guesses the column mapping from common header names', () => {
    expect(suggestMapping(['Tool ID', 'Description', 'Type', 'Store', 'Cal Interval', 'Last Cal Date', 'RFID'])).toEqual({
      assetTag: 'Tool ID', name: 'Description', category: 'Type', location: 'Store',
      calibrationIntervalDays: 'Cal Interval', lastCalibratedOn: 'Last Cal Date', rfidUid: 'RFID',
    });
  });
});

describe('saved database passwords', () => {
  it('are encrypted, and only open for the data source they belong to', () => {
    const box = new SecretBox(KEY);
    const sealed = box.seal('s3cret!', 'data_source:a');
    expect(sealed.includes(Buffer.from('s3cret!'))).toBe(false);
    expect(box.open(sealed, 'data_source:a')).toBe('s3cret!');
    expect(() => box.open(sealed, 'data_source:b')).toThrow();
    expect(() => new SecretBox('b2'.repeat(32)).open(sealed, 'data_source:a')).toThrow();
  });
});

describe('outbound address checks', () => {
  it('never reaches cloud metadata or "this host", and private networks only when allowed', () => {
    expect(() => checkAddress('169.254.169.254', true)).toThrow();
    expect(() => checkAddress('0.0.0.0', true)).toThrow();
    expect(() => checkAddress('::ffff:169.254.169.254', true)).toThrow();
    for (const a of ['127.0.0.1', '10.1.2.3', '192.168.1.10', '172.20.0.5', '::1', 'fd12::1', '::ffff:127.0.0.1']) {
      expect(() => checkAddress(a, false), a).toThrow(/private or local/);
      expect(() => checkAddress(a, true), a).not.toThrow();
    }
    expect(() => checkAddress('8.8.8.8', false)).not.toThrow();
  });
});

describe('Excel and CSV imports', () => {
  let h: Harness;
  let admin: Awaited<ReturnType<typeof signUp>>;
  let sk: Awaited<ReturnType<typeof signUp>>;
  let tech: Awaited<ReturnType<typeof signUp>>;

  beforeAll(async () => {
    h = await createHarness();
    admin = await signUp(h, 'admin');
    sk = await signUp(h, 'storekeeper');
    tech = await signUp(h, 'technician');
  });
  afterAll(() => h.close());

  const file = (rows: { row: number; values: Record<string, unknown> }[], dryRun = false) =>
    admin.client.post('/api/data-sources/files/import', { fileName: 'tools.xlsx', fileKind: 'excel', dateOrder: 'dmy', dryRun, rows });

  const tools = async () => (await admin.client.get('/api/tools')).body.tools as { assetTag: string; [k: string]: unknown }[];

  it('is for admins only', async () => {
    for (const who of [sk, tech]) {
      expect((await who.client.get('/api/data-sources')).status).toBe(403);
      expect((await who.client.post('/api/data-sources/files/import', { fileName: 'x', fileKind: 'csv', rows: [{ row: 2, values: {} }] })).status).toBe(403);
    }
  });

  it('checks first without changing anything, then imports and records it', async () => {
    const rows = [
      { row: 2, values: { assetTag: 'tw-5001', name: 'Torque Wrench 5-25 Nm', category: 'Torque', location: 'Crib A', calibrationIntervalDays: 180, lastCalibratedOn: isoDay(-10) } },
      { row: 3, values: { assetTag: 'CR-5002', name: 'Crimping Tool', location: 'Crib A' } },
      { row: 4, values: { assetTag: 'BAD TAG!', name: 'x' } },
      { row: 5, values: { assetTag: 'CR-5002', name: 'Again' } },
      { row: 6, values: { assetTag: 'TW-5003', name: 'No date', calibrationIntervalDays: '6 months' } },
      { row: 7, values: {} },
    ];
    const check = await file(rows, true);
    expect(check.status).toBe(200);
    expect(check.body.result).toMatchObject({ rows: 5, created: 2, updated: 0, skipped: 3, locationsCreated: ['Crib A'] });
    expect(check.body.result.problems.map((p: { row: number }) => p.row)).toEqual([4, 5, 6]);
    expect(await tools()).toHaveLength(0); // a dry run leaves nothing behind

    const real = await file(rows);
    expect(real.body.result).toMatchObject({ created: 2, skipped: 3 });
    const list = await tools();
    expect(list.map((t) => t.assetTag)).toEqual(['CR-5002', 'TW-5001']);
    expect(list.find((t) => t.assetTag === 'TW-5001')).toMatchObject({
      requiresCalibration: true, calibrationIntervalDays: 180, calibrationDueOn: isoDay(170), homeLocationName: 'Crib A',
    });
    expect(list.find((t) => t.assetTag === 'CR-5002')).toMatchObject({ category: 'General', requiresCalibration: false });

    const ds = (await admin.client.get('/api/data-sources')).body;
    expect(ds.runs[0]).toMatchObject({ sourceLabel: 'tools.xlsx', kind: 'excel', direction: 'import', ok: true });
    expect(ds.runs[0].summary).toMatchObject({ created: 2, skipped: 3 });

    const audit = (await admin.client.get('/api/audit')).body.entries as { action: string; details: Record<string, unknown> }[];
    expect(audit.some((e) => e.action === 'data.tools_imported')).toBe(true);
    expect(audit.filter((e) => e.action === 'tool.created')).toHaveLength(2);
  });

  it('updates by asset tag, and records newer calibrations properly', async () => {
    const r = await file([
      { row: 2, values: { assetTag: 'TW-5001', name: 'Torque Wrench 5-25 Nm (Norbar)', category: 'Torque', location: 'Crib A', calibrationIntervalDays: 180, lastCalibratedOn: isoDay(-2) } },
      { row: 3, values: { assetTag: 'CR-5002', name: 'Crimping Tool', location: 'Crib A' } },
    ]);
    expect(r.body.result).toMatchObject({ created: 0, updated: 1, unchanged: 1, calibrationsRecorded: 1 });
    const tool = (await admin.client.get('/api/tools/by-tag/TW-5001')).body.tool;
    expect(tool.name).toBe('Torque Wrench 5-25 Nm (Norbar)');
    expect(tool.calibrationDueOn).toBe(isoDay(178));
    expect(tool.calibrations[0]).toMatchObject({ calibratedOn: isoDay(-2), performedBy: 'Imported from tools.xlsx' });
  });

  it('can never unlock an expired tool by changing its settings', async () => {
    await file([{ row: 2, values: { assetTag: 'TW-5010', name: 'Old wrench', location: 'Crib A', calibrationIntervalDays: 30, lastCalibratedOn: isoDay(-60) } }]);
    expect((await admin.client.get('/api/tools/by-tag/TW-5010')).body.tool.calibrationState).toBe('expired');

    // A longer interval, an older date, or "no calibration" in the sheet: still locked, and the sheet is told why.
    const r = await file([
      { row: 2, values: { assetTag: 'TW-5010', name: 'Old wrench', location: 'Crib A', calibrationIntervalDays: 3650, lastCalibratedOn: isoDay(-90) } },
    ]);
    expect(r.body.result.problems).toEqual([expect.objectContaining({ level: 'warning', message: expect.stringMatching(/interval differs/) })]);
    const again = await file([{ row: 2, values: { assetTag: 'TW-5010', name: 'Old wrench', location: 'Crib A' } }]);
    expect(again.body.result.unchanged).toBe(1);
    expect((await admin.client.get('/api/tools/by-tag/TW-5010')).body.tool.calibrationState).toBe('expired');

    // Turning calibration on for a tool that was added without it is refused too (a person sets that up).
    const plain = await file([{ row: 2, values: { assetTag: 'CR-5002', name: 'Crimping Tool', location: 'Crib A', calibrationIntervalDays: 90, lastCalibratedOn: isoDay(-1) } }]);
    expect(plain.body.result.problems[0].message).toMatch(/only taken when a tool is first added/);
  });

  it('leaves quarantined and checked-out tools under the storekeeper\'s control', async () => {
    const tool = (await admin.client.get('/api/tools/by-tag/TW-5001')).body.tool;
    await sk.client.post('/api/checkouts', { toolId: tool.id, holderId: tech.user.id, dueBackAt: inDays(1) });
    const r = await file([
      { row: 2, values: { assetTag: 'TW-5001', name: tool.name, category: 'Torque', location: 'Crib A', calibrationIntervalDays: 180, lastCalibratedOn: isoDay(-1) } },
    ]);
    expect(r.body.result.problems[0].message).toMatch(/checked out/);
    expect(r.body.result.calibrationsRecorded).toBe(0);
  });

  it('skips a row whose RFID tag is taken, and imports the rest', async () => {
    await file([{ row: 2, values: { assetTag: 'VC-5020', name: 'Caliper', location: 'Crib A', rfidUid: '11:22:33:44' } }]);
    const r = await file([
      { row: 2, values: { assetTag: 'VC-5021', name: 'Caliper 2', location: 'Crib A', rfidUid: '11 22 33 44' } },
      { row: 3, values: { assetTag: 'VC-5022', name: 'Caliper 3', location: 'Crib A' } },
    ]);
    expect(r.body.result).toMatchObject({ created: 1, skipped: 1 });
    expect(r.body.result.problems[0]).toMatchObject({ row: 2, message: expect.stringMatching(/already on another tool/) });
  });

  it('says why database connections are unavailable', async () => {
    const ds = (await admin.client.get('/api/data-sources')).body;
    expect(ds.capabilities.databases).toEqual({ enabled: false, reason: expect.stringMatching(/DATA_SOURCE_KEY/) });
    const res = await admin.client.post('/api/data-sources/browse', {
      connection: { kind: 'postgres', host: 'db.example.com', database: 'x', username: 'u', password: 'p' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('databases_disabled');
  });
});

describe('the public demo', () => {
  it('keeps database connections off and file imports small', async () => {
    const h = await createHarness({ DEMO_MODE: 'true', DATA_SOURCE_KEY: KEY });
    try {
      const admin = await signUp(h, 'admin');
      const ds = (await admin.client.get('/api/data-sources')).body;
      expect(ds.capabilities).toMatchObject({ databases: { enabled: false }, maxFileRows: 300 });
    } finally {
      await h.close();
    }
  });
});
