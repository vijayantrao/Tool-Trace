/**
 * Reports: what the crib is worth and how it is used, plus every register as rows
 * the browser turns into an Excel file, and the calibration register auditors ask for.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { forbidden } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { db } from '../middleware/db.js';
import { currentUser, requireRole } from '../middleware/session.js';
import { CALIBRATION_NOTICE_DAYS } from '../services/jobs.js';
import type { AppEnv, Deps } from '../types.js';

const MAX_ROWS = 20_000;
const isoDate = z.iso.date();

/** Each export: its columns (key, Excel header) and whether it takes a date range. */
export const DATASETS = {
  tools: { title: 'Tool register', ranged: false },
  checkouts: { title: 'Check-out history', ranged: true },
  calibrations: { title: 'Calibration history', ranged: true },
  stock: { title: 'Stock list', ranged: false },
  movements: { title: 'Stock movements', ranged: true },
  requests: { title: 'Requests', ranged: true },
  audit: { title: 'Audit trail', ranged: true },
} as const;
type Dataset = keyof typeof DATASETS;

export function reportRoutes({ config }: Deps) {
  const app = new Hono<AppEnv>();
  const readers = requireRole('admin', 'storekeeper', 'auditor');

  app.get('/reports/summary', readers, async (c) => {
    const tx = db(c);
    const [tools] = await tx`
      SELECT count(*)::int AS count,
             coalesce(sum(unit_price), 0)::float8 AS value,
             coalesce(sum(unit_price) FILTER (WHERE status = 'checked_out'), 0)::float8 AS value_out,
             coalesce(sum(t.unit_price) FILTER (WHERE EXISTS (
               SELECT 1 FROM checkouts c WHERE c.tool_id = t.id AND c.returned_at IS NULL AND c.due_back_at < now())), 0)::float8 AS value_overdue,
             coalesce(sum(unit_price) FILTER (WHERE status = 'quarantined'), 0)::float8 AS value_quarantined,
             coalesce(sum(unit_price) FILTER (WHERE status::text = 'at_calibration'), 0)::float8 AS value_at_lab,
             count(*) FILTER (WHERE unit_price IS NULL)::int AS unpriced,
             count(*) FILTER (WHERE status = 'checked_out')::int AS out,
             count(*) FILTER (WHERE requires_calibration)::int AS calibrated
      FROM tools t WHERE status <> 'retired'`;
    const byCategory = await tx`
      SELECT category, count(*)::int AS count, coalesce(sum(unit_price), 0)::float8 AS value
      FROM tools WHERE status <> 'retired' GROUP BY category ORDER BY value DESC, count DESC LIMIT 12`;
    const byClass = await tx`
      SELECT coalesce(abc_class, 'none') AS class, count(*)::int AS count, coalesce(sum(unit_price), 0)::float8 AS value
      FROM tools WHERE status <> 'retired' GROUP BY 1 ORDER BY 1`;
    // Last 12 weeks, Monday to Sunday (plant time), including weeks with nothing.
    const weekly = await tx`
      WITH w AS (SELECT generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week') AS start)
      SELECT w.start::date::text AS week,
             (SELECT count(*)::int FROM checkouts c WHERE c.checked_out_at >= w.start AND c.checked_out_at < w.start + interval '1 week') AS checkouts,
             (SELECT count(*)::int FROM checkouts c WHERE c.returned_at >= w.start AND c.returned_at < w.start + interval '1 week'
                AND c.returned_at > c.due_back_at) AS late_returns
      FROM w ORDER BY w.start`;
    const calibrationDue = await tx`
      WITH m AS (SELECT generate_series(date_trunc('month', current_date), date_trunc('month', current_date) + interval '5 months', interval '1 month') AS start)
      SELECT to_char(m.start, 'YYYY-MM') AS month,
             (SELECT count(*)::int FROM tools t WHERE t.requires_calibration AND t.status <> 'retired'
                AND t.calibration_due_on >= greatest(m.start::date, current_date) AND t.calibration_due_on < (m.start + interval '1 month')::date) AS count
      FROM m ORDER BY m.start`;
    const [calibration] = await tx`
      SELECT count(*) FILTER (WHERE calibration_due_on < current_date AND status::text <> 'at_calibration')::int AS expired,
             count(*) FILTER (WHERE calibration_due_on BETWEEN current_date AND current_date + ${CALIBRATION_NOTICE_DAYS}::int)::int AS due_soon,
             count(*) FILTER (WHERE status::text = 'at_calibration')::int AS at_lab
      FROM tools WHERE requires_calibration AND status <> 'retired'`;
    const [stock] = await tx`
      SELECT count(*)::int AS items, coalesce(sum(unit_price * quantity), 0)::float8 AS value,
             count(*) FILTER (WHERE reorder_level > 0 AND quantity <= reorder_level)::int AS low
      FROM stock_items WHERE is_active`;
    const [other] = await tx`
      SELECT (SELECT count(*)::int FROM requests WHERE status IN ('submitted', 'reviewed', 'approved')) AS open_requests,
             (SELECT coalesce(sum(estimated_cost), 0)::float8 FROM requests WHERE status = 'approved') AS approved_cost,
             (SELECT count(*)::int FROM acknowledgements WHERE status = 'pending') AS pending_acks,
             (SELECT count(*)::int FROM acknowledgements WHERE status = 'disputed') AS disputed_acks`;
    return c.json({ currency: config.CURRENCY, tools, byCategory, byClass, weekly, calibrationDue, calibration, stock, ...other });
  });

  app.get(
    '/reports/export/:dataset',
    readers,
    validate('param', z.object({ dataset: z.enum(Object.keys(DATASETS) as [Dataset, ...Dataset[]]) })),
    validate('query', z.object({ from: isoDate.optional(), to: isoDate.optional() })),
    async (c) => {
      const { dataset } = c.req.valid('param');
      const user = currentUser(c);
      if (dataset === 'audit' && !['admin', 'auditor'].includes(user.role)) throw forbidden();
      const q = c.req.valid('query');
      const tx = db(c);
      // Dates are whole days in plant time; "to" is inclusive.
      const from = q.from ?? null;
      const to = q.to ?? null;
      let rows: Record<string, unknown>[];
      switch (dataset) {
        case 'tools':
          rows = await tx`
            SELECT t.asset_tag AS "Asset tag", t.name AS "Name", t.category AS "Category", t.make AS "Make", t.model AS "Model",
                   l.name AS "Location", t.status::text AS "Status", t.unit_price::float8 AS "Unit price", t.abc_class AS "Class",
                   t.requires_calibration AS "Calibration controlled", t.calibration_interval_days AS "Interval (days)",
                   t.last_calibrated_on::text AS "Last calibrated", t.calibration_due_on::text AS "Calibration due",
                   h.display_name AS "With", c.due_back_at AS "Due back", k.asset_tag AS "Kit", t.rfid_uid AS "RFID tag"
            FROM tools t JOIN locations l ON l.id = t.home_location_id
            LEFT JOIN checkouts c ON c.tool_id = t.id AND c.returned_at IS NULL LEFT JOIN users h ON h.id = c.holder_id
            LEFT JOIN kit_items ki ON ki.tool_id = t.id LEFT JOIN kits k ON k.id = ki.kit_id
            ORDER BY t.asset_tag LIMIT ${MAX_ROWS}`;
          break;
        case 'checkouts':
          rows = await tx`
            SELECT t.asset_tag AS "Asset tag", t.name AS "Tool", h.display_name AS "Holder", i.display_name AS "Issued by",
                   c.checked_out_at AS "Checked out", c.due_back_at AS "Due back", c.returned_at AS "Returned",
                   r.display_name AS "Received by", c.condition_on_return AS "Condition", c.notes AS "Notes",
                   (coalesce(c.returned_at, now()) > c.due_back_at) AS "Late", s.name AS "Station",
                   c.offline_queued_at AS "Made offline at", k.asset_tag AS "Kit", a.status AS "Confirmation"
            FROM checkouts c JOIN tools t ON t.id = c.tool_id JOIN users h ON h.id = c.holder_id JOIN users i ON i.id = c.issued_by
            LEFT JOIN users r ON r.id = c.received_by LEFT JOIN stations s ON s.id = c.issued_via_station_id
            LEFT JOIN kit_issues ki ON ki.id = c.kit_issue_id LEFT JOIN kits k ON k.id = ki.kit_id
            LEFT JOIN acknowledgements a ON (a.subject_type = 'checkout' AND a.subject_id = c.id) OR (a.subject_type = 'kit_issue' AND a.subject_id = c.kit_issue_id)
            WHERE (${from}::date IS NULL OR c.checked_out_at >= ${from}::date) AND (${to}::date IS NULL OR c.checked_out_at < ${to}::date + 1)
            ORDER BY c.checked_out_at DESC LIMIT ${MAX_ROWS}`;
          break;
        case 'calibrations':
          rows = await tx`
            SELECT t.asset_tag AS "Asset tag", t.name AS "Tool", r.calibrated_on::text AS "Calibrated on", r.due_on::text AS "Valid until",
                   r.performed_by AS "Calibrated by", r.certificate_ref AS "Certificate no.", (cc.id IS NOT NULL) AS "Certificate file",
                   cc.file_name AS "File name", encode(cc.sha256, 'hex') AS "File SHA-256", u.display_name AS "Recorded by", r.created_at AS "Recorded at"
            FROM calibration_records r JOIN tools t ON t.id = r.tool_id JOIN users u ON u.id = r.recorded_by
            LEFT JOIN calibration_certificates cc ON cc.calibration_record_id = r.id
            WHERE (${from}::date IS NULL OR r.calibrated_on >= ${from}::date) AND (${to}::date IS NULL OR r.calibrated_on <= ${to}::date)
            ORDER BY r.calibrated_on DESC LIMIT ${MAX_ROWS}`;
          break;
        case 'stock':
          rows = await tx`
            SELECT i.code AS "Code", i.name AS "Name", CASE i.kind WHEN 'ppe' THEN 'PPE' ELSE 'Consumable' END AS "Type",
                   i.category AS "Category", l.name AS "Location", i.quantity AS "Quantity", i.unit AS "Unit",
                   i.reorder_level AS "Reorder level", (i.reorder_level > 0 AND i.quantity <= i.reorder_level) AS "Reorder now",
                   i.unit_price::float8 AS "Unit price", (i.unit_price * i.quantity)::float8 AS "Stock value", i.abc_class AS "Class",
                   i.is_active AS "Active"
            FROM stock_items i JOIN locations l ON l.id = i.location_id ORDER BY i.code LIMIT ${MAX_ROWS}`;
          break;
        case 'movements':
          rows = await tx`
            SELECT m.at AS "When", i.code AS "Code", i.name AS "Item", m.kind AS "Movement", m.quantity AS "Change",
                   m.balance_after AS "Balance after", i.unit AS "Unit", p.display_name AS "Issued to / returned by",
                   b.display_name AS "By", m.note AS "Note", a.status AS "Confirmation"
            FROM stock_movements m JOIN stock_items i ON i.id = m.item_id JOIN users b ON b.id = m.by_user
            LEFT JOIN users p ON p.id = m.issued_to
            LEFT JOIN acknowledgements a ON a.subject_type = 'stock_issue' AND a.subject_id = m.id
            WHERE (${from}::date IS NULL OR m.at >= ${from}::date) AND (${to}::date IS NULL OR m.at < ${to}::date + 1)
            ORDER BY m.at DESC LIMIT ${MAX_ROWS}`;
          break;
        case 'requests':
          rows = await tx`
            SELECT 'REQ-' || lpad(r.number::text, 4, '0') AS "Request", r.kind AS "Type", r.reason AS "Reason", r.title AS "What",
                   r.quantity AS "Quantity", r.estimated_cost::float8 AS "Estimated cost", t.asset_tag AS "Tool", s.code AS "Stock item",
                   r.status AS "Status", q.display_name AS "Requested by", r.created_at AS "Requested at",
                   v.display_name AS "Reviewed by", d.display_name AS "Decided by", r.decided_at AS "Decided at", r.closed_at AS "Closed at"
            FROM requests r JOIN users q ON q.id = r.requested_by LEFT JOIN users v ON v.id = r.reviewed_by
            LEFT JOIN users d ON d.id = r.decided_by LEFT JOIN tools t ON t.id = r.tool_id LEFT JOIN stock_items s ON s.id = r.stock_item_id
            WHERE (${from}::date IS NULL OR r.created_at >= ${from}::date) AND (${to}::date IS NULL OR r.created_at < ${to}::date + 1)
            ORDER BY r.number DESC LIMIT ${MAX_ROWS}`;
          break;
        case 'audit':
          rows = await tx`
            SELECT a.id::int AS "Entry", a.at AS "When", a.action AS "Action", a.entity_type AS "Type", a.entity_id AS "Id",
                   u.display_name AS "By", st.name AS "Station", a.actor_ip AS "IP", a.details::text AS "Details", encode(a.hash, 'hex') AS "Hash"
            FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id LEFT JOIN stations st ON st.id = a.actor_station_id
            WHERE (${from}::date IS NULL OR a.at >= ${from}::date) AND (${to}::date IS NULL OR a.at < ${to}::date + 1)
            ORDER BY a.id DESC LIMIT ${MAX_ROWS}`;
          break;
      }
      // Column names are the Excel headers: keep them exactly as written (no camelCase transform).
      return c.json({ title: DATASETS[dataset].title, rows, truncated: rows.length === MAX_ROWS, timeZone: config.TOOLTRACE_SITE_TZ });
    },
  );

  /** The calibration register: every calibration-controlled tool, its last calibration and certificate. */
  app.get('/reports/calibration-register', readers, async (c) => {
    const tools = await db(c)`
      SELECT t.id, t.asset_tag, t.name, t.category, t.make, t.model, l.name AS location, t.status::text AS status,
             t.calibration_interval_days, t.last_calibrated_on::text AS last_calibrated_on, t.calibration_due_on::text AS calibration_due_on,
             CASE WHEN t.calibration_due_on < current_date THEN 'expired'
                  WHEN t.calibration_due_on <= current_date + 14 THEN 'due_soon' ELSE 'ok' END AS calibration_state,
             r.performed_by, r.certificate_ref, r.id AS record_id, (cc.id IS NOT NULL) AS has_certificate,
             j.lab_name AS at_lab
      FROM tools t JOIN locations l ON l.id = t.home_location_id
      LEFT JOIN LATERAL (SELECT * FROM calibration_records r WHERE r.tool_id = t.id ORDER BY r.calibrated_on DESC, r.created_at DESC LIMIT 1) r ON true
      LEFT JOIN calibration_certificates cc ON cc.calibration_record_id = r.id
      LEFT JOIN calibration_jobs j ON j.tool_id = t.id AND j.status IN ('at_lab', 'calibrated')
      WHERE t.requires_calibration AND t.status <> 'retired'
      ORDER BY t.calibration_due_on, t.asset_tag`;
    const [{ today }] = (await db(c)`SELECT current_date::text AS today`) as unknown as [{ today: string }];
    return c.json({ tools, today, timeZone: config.TOOLTRACE_SITE_TZ });
  });

  return app;
}
