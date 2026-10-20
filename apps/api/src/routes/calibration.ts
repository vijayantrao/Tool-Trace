/**
 * Sending tools to a calibration lab, the lab's single-use results link, and
 * calibration certificates.
 *
 *   send       tool (available or quarantined) -> at_calibration, the lab gets a link
 *   results    the lab (via its link) or the crib enters the date and certificate;
 *              the tool's due date moves on, but it is still at the lab
 *   receive    the tool is back: passed -> available, failed -> quarantined
 *   cancel     never sent after all: the tool goes back exactly as it was
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Sql, TxSql } from '../db.js';
import { hashToken, newToken } from '../lib/crypto.js';
import { ApiError, badRequest, conflict, notFound } from '../lib/errors.js';
import { contentDisposition, readCertificate, type UploadedFile } from '../lib/files.js';
import { rateLimit } from '../lib/rate-limit.js';
import { validate } from '../lib/validate.js';
import { AUDIT_LOCK_ID, clientIp, db } from '../middleware/db.js';
import { currentUser, requireAuth, requireRole } from '../middleware/session.js';
import type { Notifier } from '../services/notify.js';
import type { AppEnv, Deps } from '../types.js';

const LINK_DAYS = 60;
const idParam = z.object({ id: z.uuid() });
const isoDate = z.iso.date();
const tokenSchema = z.string().min(20).max(100).regex(/^[A-Za-z0-9_-]+$/);

const resultsForm = z.object({
  calibratedOn: isoDate,
  performedBy: z.string().trim().min(1).max(80),
  certificateRef: z.string().trim().max(120).optional().transform((v) => v || undefined),
});

interface JobRow {
  id: string;
  toolId: string;
  assetTag: string;
  toolName: string;
  labName: string;
  labEmail: string | null;
  status: 'at_lab' | 'calibrated' | 'received' | 'cancelled';
  previousStatus: 'available' | 'quarantined';
  sentBy: string;
  sentAt: Date;
  expectedBackOn: string;
  intervalDays: number;
}

const jobColumns = (sql: Sql | TxSql) => sql`
  j.id, j.tool_id, t.asset_tag, t.name AS tool_name, j.lab_name, j.lab_email, j.status, j.previous_status,
  j.sent_by, j.sent_at, j.expected_back_on::text AS expected_back_on, t.calibration_interval_days AS interval_days`;

async function formFields(c: Context) {
  const body = await c.req.parseBody();
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === 'string') fields[k] = v;
  return { fields, file: body.certificate };
}

/** Records a calibration from results (the lab's or the crib's), with its certificate. Same rules either way. */
async function recordResults(
  tx: TxSql,
  job: JobRow,
  r: z.infer<typeof resultsForm>,
  file: UploadedFile | null,
  by: { via: 'lab' | 'staff'; userId?: string },
) {
  const [check] = await tx<{ future: boolean; beforeSent: boolean }[]>`
    SELECT ${r.calibratedOn}::date > current_date AS future, ${r.calibratedOn}::date < ${job.sentAt}::date AS before_sent`;
  if (check!.future) throw conflict('future_date', 'The calibration date cannot be in the future');
  if (check!.beforeSent) throw conflict('date_before_sent', 'The calibration date is before the tool was sent to the lab');
  const performedBy = (by.via === 'lab' ? `${r.performedBy}, ${job.labName}` : r.performedBy).slice(0, 120);
  const [rec] = await tx<{ id: string; dueOn: string }[]>`
    INSERT INTO calibration_records (tool_id, calibrated_on, due_on, certificate_ref, performed_by, recorded_by)
    SELECT ${job.toolId}, ${r.calibratedOn}::date, ${r.calibratedOn}::date + calibration_interval_days,
           ${r.certificateRef ?? null}, ${performedBy}, ${by.userId ?? job.sentBy}
    FROM tools WHERE id = ${job.toolId}
    RETURNING id, due_on::text`;
  await tx`
    UPDATE tools SET last_calibrated_on = GREATEST(last_calibrated_on, ${r.calibratedOn}::date),
           calibration_due_on = GREATEST(calibration_due_on, ${rec!.dueOn}::date)
    WHERE id = ${job.toolId}`;
  if (file) await saveCertificate(tx, rec!.id, file, by);
  await tx`
    UPDATE calibration_jobs SET status = 'calibrated', calibration_record_id = ${rec!.id}, results_via = ${by.via},
           results_at = now(), token_hash = NULL, token_expires_at = NULL
    WHERE id = ${job.id}`;
  return rec!;
}

async function saveCertificate(tx: TxSql, recordId: string, f: UploadedFile, by: { via: 'lab' | 'staff'; userId?: string }) {
  await tx`
    INSERT INTO calibration_certificates (calibration_record_id, file_name, content_type, size_bytes, sha256, data, uploaded_via, uploaded_by)
    VALUES (${recordId}, ${f.fileName}, ${f.contentType}, ${f.data.length}, ${f.sha256}, ${f.data}, ${by.via}, ${by.userId ?? null})`;
}

const labLink = (notifier: Notifier, token: string) => notifier.url(`/lab#token=${token}`);

async function sendLink(tx: TxSql, notifier: Notifier, job: JobRow, token: string) {
  return notifier.emailLab(tx, job.id, {
    title: `Calibration of ${job.assetTag} ${job.toolName}`,
    lines: [
      `${job.assetTag} has been sent to ${job.labName} for calibration.`,
      'When it is done, use the button to enter the calibration date and attach the certificate. It takes a minute.',
    ],
    facts: [
      ['Tool', `${job.assetTag} ${job.toolName}`],
      ['Expected back', job.expectedBackOn],
    ],
    url: labLink(notifier, token),
  });
}

export function calibrationRoutes({ sql, config, notifier, limiter }: Deps) {
  const app = new Hono<AppEnv>();
  const staff = requireRole('admin', 'storekeeper');

  const loadJob = async (tx: TxSql, id: string, lock = false) => {
    const [job] = await tx<JobRow[]>`
      SELECT ${jobColumns(tx)} FROM calibration_jobs j JOIN tools t ON t.id = j.tool_id
      WHERE j.id = ${id} ${lock ? tx`FOR UPDATE OF j` : tx``}`;
    if (!job) throw notFound('Calibration job');
    return job;
  };

  // ---- Send a tool to the lab ---------------------------------------------
  app.post(
    '/tools/:id/calibration-jobs',
    staff,
    validate('param', idParam),
    validate(
      'json',
      z.object({
        labName: z.string().trim().min(1).max(120),
        labEmail: z.email().max(254).optional().or(z.literal('').transform(() => undefined)),
        expectedBackOn: isoDate,
        notes: z.string().trim().max(500).optional(),
      }),
    ),
    async (c) => {
      const { id } = c.req.valid('param');
      const b = c.req.valid('json');
      const user = currentUser(c);
      const tx = db(c);
      const [tool] = await tx<{ status: string; requiresCalibration: boolean; past: boolean }[]>`
        SELECT status::text, requires_calibration, ${b.expectedBackOn}::date < current_date AS past
        FROM tools WHERE id = ${id} FOR UPDATE`;
      if (!tool) throw notFound('Tool');
      if (!tool.requiresCalibration) throw conflict('calibration_not_required', 'This tool is not calibration-controlled');
      if (tool.status === 'at_calibration') throw conflict('already_at_lab', 'This tool is already at a calibration lab');
      if (tool.status !== 'available' && tool.status !== 'quarantined') {
        throw conflict('tool_unavailable', tool.status === 'checked_out' ? 'Return the tool before sending it for calibration' : 'Retired tools are not calibrated');
      }
      if (tool.past) throw conflict('invalid_date', 'The expected return date cannot be in the past');

      const token = newToken();
      const [created] = await tx<{ id: string }[]>`
        INSERT INTO calibration_jobs (tool_id, lab_name, lab_email, notes, expected_back_on, previous_status, sent_by,
                                      token_hash, token_expires_at)
        VALUES (${id}, ${b.labName}, ${b.labEmail?.toLowerCase() ?? null}, ${b.notes || null}, ${b.expectedBackOn}, ${tool.status},
                ${user.id}, ${hashToken(token)}, now() + make_interval(days => ${LINK_DAYS}))
        RETURNING id`;
      await tx`UPDATE tools SET status = 'at_calibration' WHERE id = ${id}`;
      const job = await loadJob(tx, created!.id);
      const emailed = await sendLink(tx, notifier, job, token);
      return c.json({ job: { id: job.id, status: job.status }, labLink: labLink(notifier, token), emailed }, 201);
    },
  );

  app.get(
    '/calibration-jobs',
    requireRole('admin', 'storekeeper', 'auditor'),
    validate('query', z.object({ open: z.enum(['true', 'false']).optional(), toolId: z.uuid().optional() })),
    async (c) => {
      const q = c.req.valid('query');
      const jobs = await db(c)`
        SELECT j.id, j.tool_id, t.asset_tag, t.name AS tool_name, j.lab_name, j.lab_email, j.notes, j.status,
               j.sent_at, j.expected_back_on::text AS expected_back_on, j.expected_back_on < current_date AND j.status IN ('at_lab', 'calibrated') AS late,
               s.display_name AS sent_by_name, j.results_via, j.results_at, j.outcome, j.closed_at, j.token_expires_at
        FROM calibration_jobs j JOIN tools t ON t.id = j.tool_id JOIN users s ON s.id = j.sent_by
        WHERE (${q.toolId ?? null}::uuid IS NULL OR j.tool_id = ${q.toolId ?? null}::uuid)
          AND (${q.open ?? null}::text IS NULL OR (j.status IN ('at_lab', 'calibrated')) = (${q.open ?? null} = 'true'))
        ORDER BY j.sent_at DESC LIMIT 200`;
      return c.json({ jobs });
    },
  );

  // A new link (the email was lost, or the old link expired). The old one stops working.
  app.post('/calibration-jobs/:id/link', staff, validate('param', idParam), async (c) => {
    const tx = db(c);
    const job = await loadJob(tx, c.req.valid('param').id, true);
    if (job.status !== 'at_lab') throw conflict('results_already_in', 'The results for this tool are already in');
    const token = newToken();
    await tx`
      UPDATE calibration_jobs SET token_hash = ${hashToken(token)}, token_expires_at = now() + make_interval(days => ${LINK_DAYS})
      WHERE id = ${job.id}`;
    const emailed = await sendLink(tx, notifier, job, token);
    return c.json({ labLink: labLink(notifier, token), emailed });
  });

  // The crib enters the results (the lab sent a paper certificate instead of using the link).
  app.post('/calibration-jobs/:id/results', staff, validate('param', idParam), async (c) => {
    const user = currentUser(c);
    const tx = db(c);
    const { fields, file } = await formFields(c);
    const parsed = resultsForm.safeParse(fields);
    if (!parsed.success) throw new ApiError(422, 'validation_failed', 'Request validation failed', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    const certificate = await readCertificate(file);
    const job = await loadJob(tx, c.req.valid('param').id, true);
    if (job.status !== 'at_lab') throw conflict('results_already_in', 'The results for this tool are already in');
    const rec = await recordResults(tx, job, parsed.data, certificate, { via: 'staff', userId: user.id });
    return c.json({ recordId: rec.id, dueOn: rec.dueOn }, 201);
  });

  app.post(
    '/calibration-jobs/:id/receive',
    staff,
    validate('param', idParam),
    validate('json', z.object({ outcome: z.enum(['passed', 'failed']) })),
    async (c) => {
      const user = currentUser(c);
      const tx = db(c);
      const { outcome } = c.req.valid('json');
      const job = await loadJob(tx, c.req.valid('param').id, true);
      if (job.status !== 'at_lab' && job.status !== 'calibrated') throw conflict('job_closed', 'This tool has already been received');
      if (outcome === 'passed' && job.status !== 'calibrated') {
        throw conflict('results_missing', 'Enter the calibration result (or wait for the lab to) before receiving it as passed');
      }
      await tx`
        UPDATE calibration_jobs SET status = 'received', outcome = ${outcome}, closed_by = ${user.id}, closed_at = now(),
               token_hash = NULL, token_expires_at = NULL
        WHERE id = ${job.id}`;
      await tx`UPDATE tools SET status = ${outcome === 'passed' ? 'available' : 'quarantined'}::tool_status WHERE id = ${job.toolId}`;
      return c.json({ ok: true, toolStatus: outcome === 'passed' ? 'available' : 'quarantined' });
    },
  );

  app.post('/calibration-jobs/:id/cancel', staff, validate('param', idParam), async (c) => {
    const user = currentUser(c);
    const tx = db(c);
    const job = await loadJob(tx, c.req.valid('param').id, true);
    if (job.status !== 'at_lab') throw conflict('cannot_cancel', 'Results are in: receive the tool instead');
    await tx`
      UPDATE calibration_jobs SET status = 'cancelled', closed_by = ${user.id}, closed_at = now(), token_hash = NULL, token_expires_at = NULL
      WHERE id = ${job.id}`;
    await tx`UPDATE tools SET status = ${job.previousStatus}::tool_status WHERE id = ${job.toolId}`;
    return c.json({ ok: true, toolStatus: job.previousStatus });
  });

  // ---- Certificates --------------------------------------------------------
  app.post('/calibration-records/:id/certificate', staff, validate('param', idParam), async (c) => {
    const user = currentUser(c);
    const tx = db(c);
    const { file } = await formFields(c);
    const certificate = await readCertificate(file);
    if (!certificate) throw badRequest('file_missing', 'Choose the certificate file');
    const [rec] = await tx`SELECT id FROM calibration_records WHERE id = ${c.req.valid('param').id}`;
    if (!rec) throw notFound('Calibration');
    const [has] = await tx`SELECT 1 FROM calibration_certificates WHERE calibration_record_id = ${rec.id}`;
    if (has) throw conflict('certificate_exists', 'This calibration already has a certificate');
    await saveCertificate(tx, rec.id as string, certificate, { via: 'staff', userId: user.id });
    return c.json({ fileName: certificate.fileName }, 201);
  });

  app.get('/calibration-records/:id/certificate', requireAuth, validate('param', idParam), async (c) => {
    const [f] = await db(c)<{ fileName: string; contentType: string; data: Buffer }[]>`
      SELECT file_name, content_type, data FROM calibration_certificates WHERE calibration_record_id = ${c.req.valid('param').id}`;
    if (!f) throw notFound('Certificate');
    return c.body(new Uint8Array(f.data), 200, {
      'Content-Type': f.contentType,
      'Content-Disposition': contentDisposition(f.fileName),
      'X-Content-Type-Options': 'nosniff',
    });
  });

  // ---- The lab's single-use link (no account) ------------------------------
  const lab = new Hono<AppEnv>();
  lab.use('*', rateLimit({ name: 'lab', limit: 20, windowMs: 60_000, store: limiter, trustProxy: config.TRUST_PROXY }));
  const findByToken = async (tx: Sql | TxSql, token: string, lock = false) => {
    const [job] = await tx<(JobRow & { expired: boolean })[]>`
      SELECT ${jobColumns(tx)}, j.token_expires_at < now() AS expired
      FROM calibration_jobs j JOIN tools t ON t.id = j.tool_id
      WHERE j.token_hash = ${hashToken(token)} ${lock ? tx`FOR UPDATE OF j` : tx``}`;
    if (!job || job.expired || job.status !== 'at_lab') {
      throw new ApiError(404, 'link_invalid', 'This link has already been used or has expired. Ask the tool crib for a new one.');
    }
    return job;
  };

  lab.post('/job', validate('json', z.object({ token: tokenSchema })), async (c) => {
    const job = await findByToken(sql, c.req.valid('json').token);
    return c.json({
      job: {
        assetTag: job.assetTag,
        toolName: job.toolName,
        labName: job.labName,
        sentAt: job.sentAt,
        expectedBackOn: job.expectedBackOn,
        intervalDays: job.intervalDays,
      },
    });
  });

  lab.post('/results', async (c) => {
    const { fields, file } = await formFields(c);
    const token = tokenSchema.safeParse(fields.token);
    if (!token.success) throw new ApiError(404, 'link_invalid', 'This link is not valid.');
    const parsed = resultsForm.safeParse(fields);
    if (!parsed.success) throw new ApiError(422, 'validation_failed', 'Request validation failed', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    const certificate = await readCertificate(file);
    const result = await sql.begin(async (tx) => {
      // As the owner (the lab has no account), in the same lock order as every other writer.
      await tx`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_ID})`;
      await tx`SELECT set_config('tooltrace.ip', ${clientIp(c, config.TRUST_PROXY)}, true)`;
      const job = await findByToken(tx, token.data, true);
      const rec = await recordResults(tx, job, parsed.data, certificate, { via: 'lab' });
      await notifier.send(tx, [job.sentBy, ...(await notifier.staff(tx))], {
        kind: 'calibration.lab_results',
        title: `${job.labName} calibrated ${job.assetTag}`,
        body: `Calibrated on ${parsed.data.calibratedOn}, valid until ${rec.dueOn}${certificate ? ', certificate attached' : ''}. Receive it when it is back at the crib.`,
        link: `/tools/${job.toolId}`,
      });
      return { assetTag: job.assetTag, dueOn: rec.dueOn };
    });
    return c.json({ ok: true, ...result }, 201);
  });

  app.route('/lab', lab);
  return app;
}
