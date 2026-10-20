/**
 * Imports a tool list (from an Excel/CSV file or another database) into
 * ToolTrace, matching tools by asset tag.
 *
 * It runs in the caller's transaction, as the signed-in admin, so row-level
 * security, the database's own checks and the audit triggers apply to every
 * row exactly as if the tool had been typed in. On top of that, an import is
 * never allowed to weaken calibration control:
 *
 * - a newer "last calibrated" date is recorded as a proper calibration record
 *   (who, when, from which source), never by editing the due date directly;
 * - a calibration interval or "needs calibration" setting is only taken when a
 *   tool is first added, so a spreadsheet can't quietly unlock an expired tool;
 * - nothing is ever deleted or retired, and quarantined tools stay quarantined.
 *
 * Each row runs in its own savepoint: a bad row is reported and skipped, the
 * rest still import.
 */
import type { TxSql } from '../../db.js';
import { normalizeUid } from '../../lib/uid.js';

export const TOOL_FIELDS = [
  { key: 'assetTag', label: 'Asset tag', required: true, hint: 'TW-0101',
    synonyms: ['asset tag', 'assettag', 'tag', 'asset', 'asset no', 'asset number', 'asset id', 'tool id', 'tool no', 'tool number', 'tool code', 'code', 'id'] },
  { key: 'name', label: 'Name', required: true, hint: 'Torque Wrench 20-100 Nm',
    synonyms: ['name', 'tool name', 'description', 'tool description', 'item', 'item name', 'tool'] },
  { key: 'category', label: 'Category', required: false, hint: 'Torque (default: General)',
    synonyms: ['category', 'type', 'tool type', 'group', 'class', 'family'] },
  { key: 'location', label: 'Location', required: false, hint: 'Main Tool Crib',
    synonyms: ['location', 'home location', 'home', 'crib', 'store', 'area', 'bay', 'kept at'] },
  { key: 'calibrationIntervalDays', label: 'Calibration interval (days)', required: false, hint: '180',
    synonyms: ['calibration interval', 'calibration interval days', 'calibration interval (days)', 'interval', 'interval days', 'cal interval', 'calibration frequency', 'frequency', 'calibration cycle', 'cycle days'] },
  { key: 'lastCalibratedOn', label: 'Last calibrated', required: false, hint: '2026-04-15',
    synonyms: ['last calibrated', 'last calibrated on', 'last calibration', 'last calibration date', 'calibrated on', 'calibration date', 'last cal', 'last cal date', 'cal date'] },
  { key: 'rfidUid', label: 'RFID tag', required: false, hint: '11:22:33:44',
    synonyms: ['rfid', 'rfid tag', 'rfid uid', 'uid', 'tag uid', 'nfc', 'rfid id'] },
  { key: 'unitPrice', label: 'Unit price', required: false, hint: '12500',
    synonyms: ['unit price', 'unitprice', 'price', 'cost', 'unit cost', 'rate', 'unit rate', 'price inr', 'price rs', 'unit price inr', 'value', 'unit value'] },
  { key: 'make', label: 'Make', required: false, hint: 'Norbar',
    synonyms: ['make', 'brand', 'manufacturer', 'mfr', 'maker', 'company'] },
  { key: 'model', label: 'Model', required: false, hint: 'TTi 100',
    synonyms: ['model', 'model no', 'model number', 'part no', 'part number', 'part'] },
] as const;

export type FieldKey = (typeof TOOL_FIELDS)[number]['key'];
export type Mapping = Partial<Record<FieldKey, string>>;
export type DateOrder = 'dmy' | 'mdy';
export type RawRow = { row: number; values: Partial<Record<FieldKey, unknown>> };

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Best guess at which column feeds which field, from the column names. */
export function suggestMapping(columns: string[]): Mapping {
  const mapping: Mapping = {};
  const taken = new Set<string>();
  for (const f of TOOL_FIELDS) {
    const wanted = new Set([squash(f.label), ...f.synonyms.map(squash)]);
    const hit = columns.find((c) => !taken.has(c) && wanted.has(squash(c)));
    if (hit) {
      mapping[f.key] = hit;
      taken.add(hit);
    }
  }
  return mapping;
}

// ---------------------------------------------------------------- values
const text = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).replace(/\s+/g, ' ').trim();
};

const pad = (n: number) => String(n).padStart(2, '0');

/** A calendar date as YYYY-MM-DD, from a Date, an Excel serial number, or text in ISO or day/month order. */
export function toIsoDate(v: unknown, order: DateOrder): string | null | 'invalid' {
  if (v === null || v === undefined || v === '') return null;
  let y: number, m: number, d: number;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return 'invalid';
    // Excel and SQL dates arrive as midnight UTC; take the calendar date as written.
    [y, m, d] = [v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate()];
  } else if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return 'invalid'; // Excel serial day numbers for 1954-2119
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86_400_000);
    [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
  } else {
    const s = text(v);
    let match;
    if ((match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/))) {
      [y, m, d] = [+match[1]!, +match[2]!, +match[3]!];
    } else if ((match = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) {
      const [a, b] = [+match[1]!, +match[2]!];
      [d, m] = order === 'dmy' ? [a, b] : [b, a];
      y = +match[3]!;
    } else {
      return 'invalid';
    }
  }
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d || y < 1950 || y > 2200) return 'invalid';
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** 12500, "12,500", "₹ 12,500.00", "Rs. 1200" -> a price with at most 2 decimals. */
export function toPrice(v: unknown): number | null | 'invalid' {
  if (v === null || v === undefined || v === '') return null;
  let n: number;
  if (typeof v === 'number') n = v;
  else {
    const s = text(v).replace(/^(₹|rs\.?|inr|\$|€|£)\s*/i, '').replace(/\s*(₹|rs\.?|inr|\/-)$/i, '').replace(/,/g, '').trim();
    if (!/^\d+(\.\d+)?$/.test(s)) return 'invalid';
    n = Number(s);
  }
  if (!Number.isFinite(n) || n < 0 || n >= 1e10) return 'invalid';
  return Math.round(n * 100) / 100;
}

/** "180", 180, "180 days", "6 months", "1 year" -> days. */
export function toIntervalDays(v: unknown): number | null | 'invalid' {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= 3650 ? v : 'invalid';
  const m = text(v).toLowerCase().match(/^(\d+)\s*(d|days?|w|weeks?|m|mon|months?|y|yrs?|years?)?$/);
  if (!m) return 'invalid';
  const unit = m[2] ?? 'd';
  const days = +m[1]! * (unit.startsWith('w') ? 7 : unit.startsWith('m') ? 30 : unit.startsWith('y') ? 365 : 1);
  return days >= 1 && days <= 3650 ? days : 'invalid';
}

// ---------------------------------------------------------------- import
export interface Problem {
  row: number;
  assetTag: string | null;
  level: 'error' | 'warning';
  message: string;
}

export interface ImportResult {
  rows: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  calibrationsRecorded: number;
  locationsCreated: string[];
  problems: Problem[];
  /** Up to 50 of the tools that would be / were added or changed. */
  changes: { row: number; assetTag: string; action: 'create' | 'update'; fields: string[] }[];
}

interface Clean {
  row: number;
  assetTag: string;
  name: string;
  category: string;
  location: string;
  intervalDays: number | null;
  lastCalibratedOn: string | null;
  rfidUid: string | null;
  unitPrice: number | null;
  make: string | null;
  model: string | null;
}

const MAX_PROBLEMS = 200;

export async function importTools(
  tx: TxSql,
  input: RawRow[],
  opts: { sourceLabel: string; dateOrder: DateOrder; actorUserId: string },
): Promise<ImportResult> {
  const result: ImportResult = {
    rows: input.length, created: 0, updated: 0, unchanged: 0, skipped: 0,
    calibrationsRecorded: 0, locationsCreated: [], problems: [], changes: [],
  };
  const problem = (p: Problem) => {
    if (result.problems.length < MAX_PROBLEMS) result.problems.push(p);
  };

  // 1. Check every row before touching anything.
  const [{ today }] = (await tx`SELECT current_date::text AS today`) as unknown as [{ today: string }]; // the plant's today
  const seen = new Map<string, number>();
  const clean: Clean[] = [];
  for (const { row, values } of input) {
    const raw = text(values.assetTag);
    if (!raw && Object.values(values).every((v) => text(v) === '')) {
      result.rows--; // a blank line, not a tool
      continue;
    }
    const assetTag = raw.toUpperCase();
    const fail = (message: string) => {
      result.skipped++;
      problem({ row, assetTag: assetTag || null, level: 'error', message });
    };
    if (!assetTag) { fail('Asset tag is empty'); continue; }
    if (!/^[A-Z0-9][A-Z0-9-]{2,31}$/.test(assetTag)) { fail(`Asset tag "${raw.slice(0, 40)}" must be 3-32 letters, digits or dashes`); continue; }
    if (seen.has(assetTag)) { fail(`Asset tag ${assetTag} appears twice (also row ${seen.get(assetTag)})`); continue; }
    seen.set(assetTag, row);
    const name = text(values.name);
    if (!name) { fail('Name is empty'); continue; }
    if (name.length > 120) { fail('Name is longer than 120 characters'); continue; }
    const category = text(values.category) || 'General';
    if (category.length > 60) { fail('Category is longer than 60 characters'); continue; }
    const location = text(values.location);
    if (location.length > 80) { fail('Location is longer than 80 characters'); continue; }
    const interval = toIntervalDays(values.calibrationIntervalDays);
    if (interval === 'invalid') { fail(`Calibration interval "${text(values.calibrationIntervalDays).slice(0, 30)}" is not a number of days between 1 and 3650`); continue; }
    const last = toIsoDate(values.lastCalibratedOn, opts.dateOrder);
    if (last === 'invalid') { fail(`Last calibrated "${text(values.lastCalibratedOn).slice(0, 30)}" is not a date`); continue; }
    if (interval && !last) { fail('Has a calibration interval but no last-calibrated date'); continue; }
    if (last && !interval) { fail('Has a last-calibrated date but no calibration interval'); continue; }
    if (last && last > today) { fail(`Last calibrated ${last} is in the future`); continue; }
    let rfidUid: string | null = null;
    if (text(values.rfidUid)) {
      rfidUid = normalizeUid(text(values.rfidUid));
      if (!rfidUid) { fail(`RFID tag "${text(values.rfidUid).slice(0, 40)}" must be 4, 7 or 10 bytes of hex, like 11:22:33:44`); continue; }
    }
    const unitPrice = toPrice(values.unitPrice);
    if (unitPrice === 'invalid') { fail(`Unit price "${text(values.unitPrice).slice(0, 30)}" is not an amount`); continue; }
    const make = text(values.make) || null;
    const model = text(values.model) || null;
    if ((make?.length ?? 0) > 80 || (model?.length ?? 0) > 80) { fail('Make or model is longer than 80 characters'); continue; }
    clean.push({ row, assetTag, name, category, location, intervalDays: interval, lastCalibratedOn: last, rfidUid, unitPrice, make, model });
  }

  // 2. Locations: match by name (any case); create the missing ones as tool cribs, up front.
  const locations = new Map<string, string>(
    (await tx<{ id: string; name: string }[]>`SELECT id, name FROM locations ORDER BY name`).map((l) => [l.name.toLowerCase(), l.id]),
  );
  const createLocation = async (name: string) => {
    const [l] = await tx<{ id: string }[]>`INSERT INTO locations (name, kind) VALUES (${name}, 'crib') RETURNING id`;
    locations.set(name.toLowerCase(), l!.id);
    result.locationsCreated.push(name);
    return l!.id;
  };
  let defaultLocation: string | undefined;
  if (clean.some((c) => !c.location)) {
    const [firstCrib] = await tx<{ id: string }[]>`SELECT id FROM locations WHERE kind = 'crib' ORDER BY created_at LIMIT 1`;
    defaultLocation = firstCrib?.id ?? locations.get('main tool crib') ?? (await createLocation('Main Tool Crib'));
  }
  for (const c of clean) {
    if (c.location && !locations.has(c.location.toLowerCase())) await createLocation(c.location);
  }
  const locationId = (name: string) => (name ? locations.get(name.toLowerCase())! : defaultLocation!);

  // 3. Apply, one savepoint per row.
  const existing = new Map(
    (
      await tx<{ id: string; assetTag: string; name: string; category: string; homeLocationId: string; rfidUid: string | null;
        status: string; requiresCalibration: boolean; calibrationIntervalDays: number | null; lastCalibratedOn: string | null;
        unitPrice: number | null; make: string | null; model: string | null }[]>`
        SELECT id, asset_tag, name, category, home_location_id, rfid_uid, status::text, requires_calibration,
               calibration_interval_days, last_calibrated_on::text AS last_calibrated_on,
               unit_price::float8 AS unit_price, make, model
        FROM tools WHERE asset_tag = ANY(${clean.map((c) => c.assetTag)})`
    ).map((t) => [t.assetTag, t]),
  );
  const performedBy = `Imported from ${opts.sourceLabel}`.slice(0, 120);

  for (const c of clean) {
    const warn = (message: string) => problem({ row: c.row, assetTag: c.assetTag, level: 'warning', message });
    try {
      await tx.savepoint(async (sp) => {
        const loc = locationId(c.location);
        const old = existing.get(c.assetTag);
        if (!old) {
          const cal = c.intervalDays !== null;
          await sp`
            INSERT INTO tools (asset_tag, name, category, home_location_id, rfid_uid, requires_calibration,
                               calibration_interval_days, last_calibrated_on, calibration_due_on, unit_price, make, model)
            VALUES (${c.assetTag}, ${c.name}, ${c.category}, ${loc}, ${c.rfidUid}, ${cal},
                    ${c.intervalDays}, ${c.lastCalibratedOn}::date, ${c.lastCalibratedOn}::date + ${c.intervalDays ?? 0}::int,
                    ${c.unitPrice}, ${c.make}, ${c.model})`;
          result.created++;
          if (result.changes.length < 50) result.changes.push({ row: c.row, assetTag: c.assetTag, action: 'create', fields: [] });
          return;
        }

        const fields: string[] = [];
        if (old.name !== c.name) fields.push('name');
        if (old.category !== c.category) fields.push('category');
        if (old.homeLocationId !== loc) fields.push('location');
        // An empty RFID cell means "not in this sheet", never "remove the tag".
        if (c.rfidUid && old.rfidUid !== c.rfidUid) fields.push('RFID tag');
        // Empty price, make or model cells mean "not in this sheet" too.
        if (c.unitPrice !== null && old.unitPrice !== c.unitPrice) fields.push('price');
        if (c.make && old.make !== c.make) fields.push('make');
        if (c.model && old.model !== c.model) fields.push('model');
        if (fields.length) {
          await sp`
            UPDATE tools SET name = ${c.name}, category = ${c.category}, home_location_id = ${loc},
                   rfid_uid = COALESCE(${c.rfidUid}, rfid_uid), unit_price = COALESCE(${c.unitPrice}::numeric, unit_price),
                   make = COALESCE(${c.make}, make), model = COALESCE(${c.model}, model)
            WHERE id = ${old.id}`;
        }

        if (c.intervalDays !== null) {
          if (!old.requiresCalibration) {
            warn('Calibration settings are only taken when a tool is first added; this tool is not calibration-controlled in ToolTrace');
          } else {
            if (old.calibrationIntervalDays !== c.intervalDays) {
              warn(`Calibration interval differs (${c.intervalDays} in the source, ${old.calibrationIntervalDays} in ToolTrace); kept ToolTrace's`);
            }
            if (c.lastCalibratedOn && (!old.lastCalibratedOn || c.lastCalibratedOn > old.lastCalibratedOn)) {
              if (old.status === 'checked_out') {
                warn(`Newer calibration (${c.lastCalibratedOn}) not recorded: the tool is checked out. Record it when it is returned.`);
              } else {
                // Exactly what "Record calibration" does, minus releasing a quarantine: a person decides that.
                const [rec] = await sp<{ dueOn: string }[]>`
                  INSERT INTO calibration_records (tool_id, calibrated_on, due_on, certificate_ref, performed_by, recorded_by)
                  SELECT id, ${c.lastCalibratedOn}::date, ${c.lastCalibratedOn}::date + calibration_interval_days,
                         NULL, ${performedBy}, ${opts.actorUserId}
                  FROM tools WHERE id = ${old.id}
                  RETURNING due_on::text`;
                await sp`
                  UPDATE tools SET last_calibrated_on = GREATEST(last_calibrated_on, ${c.lastCalibratedOn}::date),
                         calibration_due_on = GREATEST(calibration_due_on, ${rec!.dueOn}::date)
                  WHERE id = ${old.id}`;
                result.calibrationsRecorded++;
                fields.push('calibration');
              }
            }
          }
        }

        if (fields.length) {
          result.updated++;
          if (result.changes.length < 50) result.changes.push({ row: c.row, assetTag: c.assetTag, action: 'update', fields });
        } else {
          result.unchanged++;
        }
      });
    } catch (err) {
      result.skipped++;
      const e = err as { hint?: string; code?: string; constraint_name?: string };
      const message =
        e.hint === 'uid_in_use' || (e.code === '23505' && e.constraint_name?.includes('rfid'))
          ? `RFID tag ${c.rfidUid} is already on another tool or badge`
        : e.code === '23514' ? 'The values break one of ToolTrace\'s rules'
        : e.code === '23505' ? 'A tool or location with that value already exists'
        : 'Could not be saved';
      problem({ row: c.row, assetTag: c.assetTag, level: 'error', message });
    }
  }
  return result;
}
