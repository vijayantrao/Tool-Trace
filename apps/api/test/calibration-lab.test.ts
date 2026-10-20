import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, inDays, isoDay, signUp, type Harness, type TestClient } from './helpers/harness.js';

const MAIL = { SMTP_URL: 'smtp://user:pass@mail.example.com:587', MAIL_FROM: 'ToolTrace <alerts@example.com>' };
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048, 0x20), Buffer.from('\n%%EOF\n')]);
const pdf = (name = 'certificate.pdf', bytes = PDF) => new File([bytes], name, { type: 'application/pdf' });

describe('sending tools to a calibration lab', () => {
  let h: Harness;
  let admin: Awaited<ReturnType<typeof signUp>>;
  let sk: Awaited<ReturnType<typeof signUp>>;
  let tech: Awaited<ReturnType<typeof signUp>>;
  let loc: string;
  const tool = async (tag: string, daysAgo = 170) =>
    (
      await sk.client.post('/api/tools', {
        assetTag: tag, name: `Torque wrench ${tag}`, category: 'Torque', homeLocationId: loc,
        requiresCalibration: true, calibrationIntervalDays: 180, lastCalibratedOn: isoDay(-daysAgo),
      })
    ).body.tool as { id: string };
  const send = (id: string, extra: Record<string, unknown> = {}) =>
    sk.client.post(`/api/tools/${id}/calibration-jobs`, { labName: 'Precision Cal Lab', labEmail: 'Lab@Example.com', expectedBackOn: isoDay(7), ...extra });
  const token = (link: string) => new URL(link).hash.replace('#token=', '');
  let lab: TestClient; // the lab: no account, no session

  beforeAll(async () => {
    h = await createHarness(MAIL);
    admin = await signUp(h, 'admin');
    sk = await signUp(h, 'storekeeper', 'Ravi Kumar');
    tech = await signUp(h, 'technician', 'Asha Verma');
    loc = (await sk.client.post('/api/locations', { name: 'Crib', kind: 'crib' })).body.location.id;
    lab = h.client();
  });
  afterAll(() => h.close());

  it('takes the tool off the board, and emails the lab a single-use link', async () => {
    const t = await tool('CAL-0001');
    const res = await send(t.id);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ emailed: true, labLink: expect.stringMatching(/^http:\/\/localhost:3000\/lab#token=/) });

    const detail = (await sk.client.get(`/api/tools/${t.id}`)).body.tool;
    expect(detail).toMatchObject({ status: 'at_calibration', labJob: { labName: 'Precision Cal Lab', labEmail: 'lab@example.com', status: 'at_lab' } });
    // Nobody can take it while it's away, and the shop floor doesn't see the lab's details.
    const take = await tech.client.post('/api/checkouts', { toolId: t.id, dueBackAt: inDays(1) });
    expect(take.body.error.code).toBe('tool_unavailable');
    expect((await tech.client.get(`/api/tools/${t.id}`)).body.tool.labJob).toBeNull();
    expect((await tech.client.post(`/api/tools/${t.id}/calibration-jobs`, { labName: 'x', expectedBackOn: isoDay(1) })).status).toBe(403);
    // Not twice, and not by changing its status by hand.
    expect((await send(t.id)).body.error.code).toBe('already_at_lab');
    expect((await sk.client.patch(`/api/tools/${t.id}`, { status: 'available' })).body.error.code).toBe('tool_at_lab');

    await h.deliver();
    const mail = h.mailbox.find((m) => m.to === 'lab@example.com')!;
    expect(mail.subject).toBe('Calibration of CAL-0001 Torque wrench CAL-0001');
    expect(mail.html).toContain(res.body.labLink.replace(/&/g, '&amp;'));
    const audit = (await admin.client.get(`/api/audit?entityId=${t.id}`)).body.entries;
    expect(audit[0]).toMatchObject({ action: 'calibration.sent', details: { lab: 'Precision Cal Lab', linkIssued: true } });
  });

  it('lets the lab enter the result and attach the certificate, once, without an account', async () => {
    const t = await tool('CAL-0002');
    const link = (await send(t.id)).body.labLink as string;
    const info = await lab.post('/api/lab/job', { token: token(link) });
    expect(info.body.job).toMatchObject({ assetTag: 'CAL-0002', labName: 'Precision Cal Lab', intervalDays: 180 });

    // Checked: not in the future, not before it was sent, a real PDF/JPEG/PNG.
    const bad = async (form: Record<string, string | File>) => (await lab.upload('/api/lab/results', { token: token(link), performedBy: 'S. Rao', ...form })).body.error.code;
    expect(await bad({ calibratedOn: isoDay(1) })).toBe('future_date');
    expect(await bad({ calibratedOn: isoDay(-3) })).toBe('date_before_sent');
    expect(await bad({ calibratedOn: isoDay(0), certificate: new File(['<script>alert(1)</script>'], 'cert.pdf') })).toBe('invalid_file_type');
    expect(await bad({ calibratedOn: isoDay(0), certificate: pdf('big.pdf', Buffer.concat([PDF, Buffer.alloc(3 * 1024 * 1024)])) })).toMatch(/file_too_large|payload_too_large/);

    const ok = await lab.upload('/api/lab/results', {
      token: token(link), calibratedOn: isoDay(0), performedBy: 'S. Rao', certificateRef: 'PCL-2026-118', certificate: pdf('PCL 2026-118 <final>.pdf'),
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ assetTag: 'CAL-0002', dueOn: isoDay(180) });
    expect((await lab.upload('/api/lab/results', { token: token(link), calibratedOn: isoDay(0), performedBy: 'x' })).body.error.code).toBe('link_invalid');
    expect((await lab.post('/api/lab/job', { token: token(link) })).body.error.code).toBe('link_invalid');

    // The due date moved on, but the tool is still at the lab until someone receives it.
    const detail = (await sk.client.get(`/api/tools/${t.id}`)).body.tool;
    expect(detail).toMatchObject({ status: 'at_calibration', calibrationDueOn: isoDay(180), labJob: { status: 'calibrated', resultsVia: 'lab' } });
    expect(detail.calibrations[0]).toMatchObject({ performedBy: 'S. Rao, Precision Cal Lab', certificateRef: 'PCL-2026-118', certificateFile: 'PCL 2026-118 final.pdf' });
    expect((await sk.client.get('/api/notifications')).body.notifications[0]).toMatchObject({ kind: 'calibration.lab_results', title: 'Precision Cal Lab calibrated CAL-0002' });

    // Anyone signed in can read the certificate: exactly the bytes the lab sent, as a download.
    const file = await tech.client.download(`/api/calibration-records/${detail.calibrations[0].id}/certificate`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/pdf');
    expect(file.headers.get('content-disposition')).toMatch(/^attachment; filename="PCL 2026-118 final.pdf"/);
    expect(file.bytes.equals(PDF)).toBe(true);
    const audit = (await admin.client.get(`/api/audit?entityId=${t.id}`)).body.entries.map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['calibration.results_entered', 'calibration.certificate_added', 'calibration.recorded']));
    const cert = (await admin.client.get(`/api/audit?action=calibration.certificate_added&entityId=${t.id}`)).body.entries[0];
    expect(cert.details.sha256).toBe(createHash('sha256').update(PDF).digest('hex'));

    // Received as passed: back on the board and can be issued.
    expect((await sk.client.post(`/api/calibration-jobs/${detail.labJob.id}/receive`, { outcome: 'passed' })).body.toolStatus).toBe('available');
    expect((await tech.client.post('/api/checkouts', { toolId: t.id, dueBackAt: inDays(1) })).status).toBe(201);
    // Certificates are evidence: never changed.
    await expect(h.sql`UPDATE calibration_certificates SET file_name = 'x.pdf'`).rejects.toThrow(/cannot be changed/);
  });

  it('lets the crib enter results from a paper certificate, and receive a failed tool into quarantine', async () => {
    const t = await tool('CAL-0003', 200); // already expired
    await send(t.id);
    const job = (await sk.client.get(`/api/tools/${t.id}`)).body.tool.labJob;
    expect((await sk.client.post(`/api/calibration-jobs/${job.id}/receive`, { outcome: 'passed' })).body.error.code).toBe('results_missing');
    const res = await sk.client.upload(`/api/calibration-jobs/${job.id}/results`, { calibratedOn: isoDay(0), performedBy: 'Precision Cal Lab' });
    expect(res.status).toBe(201);
    expect((await sk.client.get(`/api/tools/${t.id}`)).body.tool.calibrationState).toBe('ok');
    expect((await sk.client.post(`/api/calibration-jobs/${job.id}/receive`, { outcome: 'failed' })).body.toolStatus).toBe('quarantined');
    // A certificate can be added later, once.
    const rec = (await sk.client.get(`/api/tools/${t.id}`)).body.tool.calibrations[0].id;
    expect((await tech.client.upload(`/api/calibration-records/${rec}/certificate`, { certificate: pdf() })).status).toBe(403);
    expect((await sk.client.upload(`/api/calibration-records/${rec}/certificate`, { certificate: pdf() })).status).toBe(201);
    expect((await sk.client.upload(`/api/calibration-records/${rec}/certificate`, { certificate: pdf() })).body.error.code).toBe('certificate_exists');
  });

  it('cancelling puts the tool back exactly as it was, and a new link replaces the old one', async () => {
    const t = await tool('CAL-0004');
    await sk.client.patch(`/api/tools/${t.id}`, { status: 'quarantined' });
    const first = (await send(t.id, { labEmail: '' })).body;
    expect(first.emailed).toBe(false);
    const job = (await sk.client.get(`/api/tools/${t.id}`)).body.tool.labJob;
    const second = (await sk.client.post(`/api/calibration-jobs/${job.id}/link`)).body.labLink;
    expect((await lab.post('/api/lab/job', { token: token(first.labLink) })).status).toBe(404);
    expect((await lab.post('/api/lab/job', { token: token(second) })).status).toBe(200);
    expect((await sk.client.post(`/api/calibration-jobs/${job.id}/cancel`)).body.toolStatus).toBe('quarantined');
    expect((await lab.post('/api/lab/job', { token: token(second) })).status).toBe(404);
    expect((await sk.client.get(`/api/tools/${t.id}`)).body.tool).toMatchObject({ status: 'quarantined', labJob: null });
  });

  it('only sends calibration-controlled tools that are in the crib, and reminds when the lab is late', async () => {
    const plain = (await sk.client.post('/api/tools', { assetTag: 'CAL-0005', name: 'Hammer', category: 'Hand', homeLocationId: loc })).body.tool;
    expect((await send(plain.id)).body.error.code).toBe('calibration_not_required');
    const t = await tool('CAL-0006');
    await tech.client.post('/api/checkouts', { toolId: t.id, dueBackAt: inDays(1) });
    expect((await send(t.id)).body.error.code).toBe('tool_unavailable');
    expect((await send((await tool('CAL-0007')).id, { expectedBackOn: isoDay(-1) })).body.error.code).toBe('invalid_date');

    const late = await tool('CAL-0008');
    await send(late.id);
    await h.sql`UPDATE calibration_jobs SET expected_back_on = current_date - 2 WHERE tool_id = ${late.id}`;
    expect((await h.jobs.runDue()).labLate).toBe(2); // the storekeeper who sent it (also crib staff) and the admin
    expect((await h.jobs.runDue()).labLate).toBe(0);
  });
});
