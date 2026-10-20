import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createHarness, signUp, type Harness } from './helpers/harness.js';

/** A real zone whose calendar date differs from UTC's right now (one of these always does). */
const dayIn = (tz: string, offsetDays = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(Date.now() + offsetDays * 86_400_000));
const utcDay = () => new Date().toISOString().slice(0, 10);
const SITE = ['Pacific/Kiritimati', 'Pacific/Pago_Pago'].find((tz) => dayIn(tz) !== utcDay())!;

describe("the plant's own calendar", () => {
  let h: Harness;
  let sk: Awaited<ReturnType<typeof signUp>>;
  let loc: string;

  beforeAll(async () => {
    h = await createHarness({ TOOLTRACE_SITE_TZ: SITE });
    sk = await signUp(h, 'storekeeper');
    loc = (await sk.client.post('/api/locations', { name: 'Crib', kind: 'crib' })).body.location.id;
  });
  afterAll(() => h.close());

  it('is what "today" means in the database', async () => {
    const [row] = await h.sql<{ today: string }[]>`SELECT current_date::text AS today`;
    expect(row!.today).toBe(dayIn(SITE));
  });

  it('accepts a calibration done today on the shop floor, and expires tools at local midnight', async () => {
    const tool = await sk.client.post('/api/tools', {
      assetTag: 'TZ-0001', name: 'Torque wrench', category: 'Torque', homeLocationId: loc,
      requiresCalibration: true, calibrationIntervalDays: 30, lastCalibratedOn: dayIn(SITE, -30),
    });
    expect(tool.status).toBe(201);
    // Due today, local time: still usable today.
    expect(tool.body.tool).toMatchObject({ calibrationDueOn: dayIn(SITE), calibrationState: 'due_soon' });

    const rec = await sk.client.post(`/api/tools/${tool.body.tool.id}/calibrations`, {
      calibratedOn: dayIn(SITE), performedBy: 'Calibration lab',
    });
    expect(rec.status).toBe(201);
    expect(rec.body.tool.calibrationDueOn).toBe(dayIn(SITE, 30));

    const tomorrow = await sk.client.post(`/api/tools/${tool.body.tool.id}/calibrations`, {
      calibratedOn: dayIn(SITE, 1), performedBy: 'Calibration lab',
    });
    expect(tomorrow.body.error.code).toBe('future_date');
  });

  it('defaults to India and refuses names that are not time zones', () => {
    const base = { DATABASE_URL: 'postgres://x', APP_URL: 'http://localhost:3000', RP_ID: 'localhost', RP_ORIGINS: 'http://localhost:3000' };
    expect(loadConfig(base).TOOLTRACE_SITE_TZ).toBe('Asia/Kolkata');
    expect(() => loadConfig({ ...base, TOOLTRACE_SITE_TZ: 'Mars/Olympus' })).toThrow(/TOOLTRACE_SITE_TZ/);
  });
});
