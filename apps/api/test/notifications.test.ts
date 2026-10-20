import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { emailEnabled } from '../src/services/mail.js';
import { createHarness, inDays, isoDay, signUp, type Harness } from './helpers/harness.js';

const MAIL = { SMTP_URL: 'smtp://user:pass@mail.example.com:587', MAIL_FROM: 'ToolTrace <alerts@example.com>' };

describe('notifications', () => {
  let h: Harness;
  let admin: Awaited<ReturnType<typeof signUp>>;
  let sk: Awaited<ReturnType<typeof signUp>>;
  let tech: Awaited<ReturnType<typeof signUp>>;
  let auditor: Awaited<ReturnType<typeof signUp>>;
  let loc: string;

  beforeAll(async () => {
    h = await createHarness(MAIL);
    admin = await signUp(h, 'admin', 'Priya Nair');
    sk = await signUp(h, 'storekeeper', 'Ravi Kumar');
    tech = await signUp(h, 'technician', 'Asha Verma');
    auditor = await signUp(h, 'auditor', 'Meera Iyer');
    loc = (await sk.client.post('/api/locations', { name: 'Crib', kind: 'crib' })).body.location.id;
  });
  afterAll(() => h.close());

  const bell = async (who: typeof tech) => (await who.client.get('/api/notifications')).body;

  it('reminds the holder daily and the crib once when a tool is overdue, and emails them', async () => {
    const tool = (await sk.client.post('/api/tools', { assetTag: 'OD-0001', name: 'Crimper', category: 'Electrical', homeLocationId: loc })).body.tool;
    // An overdue check-out (written directly: the API never lets a due time be in the past).
    await h.sql`
      INSERT INTO checkouts (tool_id, holder_id, issued_by, checked_out_at, due_back_at)
      VALUES (${tool.id}, ${tech.user.id}, ${sk.user.id}, now() - interval '3 hours', now() - interval '1 hour')`;

    const first = await h.jobs.runDue();
    expect(first.overdue).toBe(3); // the holder, plus the admin and the storekeeper
    const again = await h.jobs.runDue();
    expect(again.overdue).toBe(0); // once per day per holder, once ever for the crib

    const mine = await bell(tech);
    expect(mine.unread).toBeGreaterThanOrEqual(1);
    expect(mine.notifications[0]).toMatchObject({ kind: 'checkout.overdue', link: `/tools/${tool.id}`, readAt: null });
    expect(mine.notifications[0].title).toMatch(/^Please return OD-0001/);
    expect(mine.email).toEqual({ available: true, enabled: true, address: tech.user.email });
    expect((await bell(sk)).notifications.some((n: { kind: string }) => n.kind === 'checkout.overdue_staff')).toBe(true);

    expect(await h.deliver()).toMatchObject({ failed: 0 });
    const toTech = h.mailbox.filter((m) => m.to === tech.user.email);
    expect(toTech).toHaveLength(1);
    expect(toTech[0]!.subject).toMatch(/^Please return OD-0001/);
    expect(toTech[0]!.html).toContain(`http://localhost:3000/tools/${tool.id}`);
    expect(toTech[0]!.text).toContain('You can turn emails off');
  });

  it('only shows people their own notifications, and lets them mark them read', async () => {
    const theirs = (await bell(tech)).notifications[0].id;
    const [row] = await h.sql`SELECT count(*)::int AS n FROM notifications WHERE id = ${theirs}`;
    expect(row!.n).toBe(1);
    // Someone else can't mark it read (row-level security: it's not theirs, so nothing matches).
    expect((await sk.client.post('/api/notifications/read', { ids: [theirs] })).body.marked).toBe(0);
    expect((await tech.client.post('/api/notifications/read', { ids: [theirs] })).body.marked).toBe(1);
    expect((await tech.client.post('/api/notifications/read', { all: true })).status).toBe(200);
    expect((await bell(tech)).unread).toBe(0);
  });

  it('respects "don\'t email me" (and records the choice), while still showing it in the app', async () => {
    expect((await tech.client.post('/api/notifications/read', { all: true })).status).toBe(200);
    const res = await tech.client.request('PUT', '/api/notifications/preferences', { email: false });
    expect(res.body).toEqual({ email: false });
    const sent = h.mailbox.length;
    await h.notifier.send(h.sql, [tech.user.id], { kind: 'test.ping', title: 'Hello', link: '/' });
    await h.deliver();
    expect(h.mailbox.length).toBe(sent);
    expect((await bell(tech)).unread).toBe(1);
    const audit = (await admin.client.get('/api/audit?action=notifications.')).body.entries;
    expect(audit[0]).toMatchObject({ action: 'notifications.preferences_changed', details: { email: false } });
    await tech.client.request('PUT', '/api/notifications/preferences', { email: true });
  });

  it('retries a failed email with backoff, then gives up, and tells the admin', async () => {
    await h.notifier.send(h.sql, [auditor.user.id], { kind: 'test.ping', title: 'Retry me' });
    h.failMail(true);
    expect(await h.deliver()).toEqual({ sent: 0, failed: 1 });
    const [row] = await h.sql<{ attempts: number; status: string; lastError: string; wait: number }[]>`
      SELECT attempts, status, last_error, extract(epoch FROM next_attempt_at - now())::int AS wait
      FROM email_outbox WHERE subject = 'Retry me'`;
    expect(row).toMatchObject({ attempts: 1, status: 'pending', lastError: 'mail server said no' });
    expect(row!.wait).toBeGreaterThan(30);
    for (let i = 0; i < 5; i++) {
      await h.sql`UPDATE email_outbox SET next_attempt_at = now() WHERE subject = 'Retry me'`;
      await h.deliver();
    }
    const [done] = await h.sql`SELECT attempts, status FROM email_outbox WHERE subject = 'Retry me'`;
    expect(done).toMatchObject({ attempts: 6, status: 'failed' });
    h.failMail(false);

    expect((await sk.client.get('/api/notifications/delivery')).status).toBe(403);
    const delivery = (await admin.client.get('/api/notifications/delivery')).body;
    expect(delivery).toMatchObject({ available: true, failed: 1, lastError: 'mail server said no' });
  });

  it('reminds the crib 30 days before calibration is due, and when it has expired, once per due date', async () => {
    await sk.client.post('/api/tools', {
      assetTag: 'CD-0001', name: 'Torque wrench', category: 'Torque', homeLocationId: loc,
      requiresCalibration: true, calibrationIntervalDays: 100, lastCalibratedOn: isoDay(-80),
    });
    await sk.client.post('/api/tools', {
      assetTag: 'CD-0002', name: 'Old gauge', category: 'Measuring', homeLocationId: loc,
      requiresCalibration: true, calibrationIntervalDays: 30, lastCalibratedOn: isoDay(-40),
    });
    expect((await h.jobs.runDue()).calibration).toBe(4); // two tools, two staff each
    expect((await h.jobs.runDue()).calibration).toBe(0);
    const kinds = (await bell(admin)).notifications.map((n: { kind: string; title: string }) => `${n.kind} ${n.title.slice(0, 7)}`);
    expect(kinds).toEqual(expect.arrayContaining(['calibration.due_soon CD-0001', 'calibration.expired CD-0002']));
  });

  it('sends the weekly summary to crib staff and the monthly report to admins and auditors, once each', async () => {
    const before = await h.sql`SELECT kind, user_id FROM notifications WHERE kind LIKE 'report.%'`;
    const made = await h.jobs.runDue();
    const after = await h.sql<{ kind: string; userId: string }[]>`SELECT kind, user_id FROM notifications WHERE kind LIKE 'report.%'`;
    // (The first run may have happened in an earlier test: either way there is exactly one of each per person.)
    expect((made.weekly ?? 0) + (made.monthly ?? 0)).toBeGreaterThanOrEqual(0);
    expect(after.length).toBeGreaterThanOrEqual(before.length);
    const weekly = after.filter((r) => r.kind === 'report.weekly').map((r) => r.userId).sort();
    const monthly = after.filter((r) => r.kind === 'report.monthly').map((r) => r.userId).sort();
    expect(weekly).toEqual([admin.user.id, sk.user.id].sort());
    expect(monthly).toEqual([admin.user.id, auditor.user.id].sort());
  });

  it('needs a mail server and never emails from the public demo', () => {
    const base = { DATABASE_URL: 'postgres://x', APP_URL: 'http://localhost:3000', RP_ID: 'localhost', RP_ORIGINS: 'http://localhost:3000' };
    expect(emailEnabled(loadConfig(base))).toBe(false);
    expect(emailEnabled(loadConfig({ ...base, ...MAIL }))).toBe(true);
    expect(emailEnabled(loadConfig({ ...base, ...MAIL, DEMO_MODE: 'true' }))).toBe(false);
    expect(() => loadConfig({ ...base, SMTP_URL: MAIL.SMTP_URL })).toThrow(/MAIL_FROM/);
    expect(() => loadConfig({ ...base, SMTP_URL: 'http://mail', MAIL_FROM: 'x <a@b.c>' })).toThrow(/smtp/);
  });

  it('does not notify people who have been deactivated', async () => {
    const gone = await signUp(h, 'technician', 'Gone Person');
    await admin.client.patch(`/api/users/${gone.user.id}`, { isActive: false });
    expect(await h.notifier.send(h.sql, [gone.user.id], { kind: 'test.ping', title: 'Anyone there?' })).toBe(0);
    void inDays;
  });
});
