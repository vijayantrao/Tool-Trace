/**
 * Excel and CSV in the browser. Files are read here, on the admin's own
 * computer, and only the mapped values are sent to the server: the API never
 * has to unpack an uploaded spreadsheet.
 */
import type { FieldKey, Mapping, Tool, ToolField } from './types';

export type Cell = string | number | boolean | null;

export interface FileTable {
  sheet: string;
  columns: string[];
  /** Sheet row number (1-based, as Excel shows it) and the cells by column name. */
  rows: { row: number; cells: Record<string, Cell> }[];
}

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Dates become YYYY-MM-DD (the calendar date as written in the sheet). */
const toCell = (v: unknown): Cell => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim().slice(0, 500);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v).slice(0, 500);
};

/** Turns a grid into a table: the first row with at least two filled cells is the header. */
function toTable(sheet: string, grid: unknown[][]): FileTable | null {
  const headerIndex = grid.findIndex((r) => r.filter((c) => toCell(c) !== null).length >= 2);
  if (headerIndex < 0) return null;
  const seen = new Map<string, number>();
  const columns = grid[headerIndex]!.map((c, i) => {
    let name = String(toCell(c) ?? '').trim() || `Column ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}`;
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    if (n) name = `${name} (${n + 1})`;
    return name;
  });
  const rows = grid
    .slice(headerIndex + 1)
    .map((r, i) => ({ row: headerIndex + 2 + i, cells: Object.fromEntries(columns.map((col, k) => [col, toCell(r[k])])) }))
    .filter((r) => Object.values(r.cells).some((v) => v !== null));
  return { sheet, columns, rows };
}

export async function readSpreadsheet(file: File): Promise<FileTable[]> {
  if (file.size > MAX_FILE_BYTES) throw new Error('That file is larger than 10 MB.');
  if (/\.csv$/i.test(file.name) || file.type === 'text/csv') {
    const Papa = (await import('papaparse')).default;
    const text = await file.text();
    const parsed = Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: 'greedy' });
    const table = toTable(file.name.replace(/\.csv$/i, ''), parsed.data);
    if (!table) throw new Error('No header row found. The first row should name the columns.');
    return [table];
  }
  if (!/\.xlsx$/i.test(file.name)) throw new Error('Choose an Excel workbook (.xlsx) or a CSV file. Older .xls files: open in Excel and save as .xlsx.');
  const readXlsxFile = (await import('read-excel-file/browser')).default;
  let sheets;
  try {
    sheets = await readXlsxFile(file);
  } catch {
    throw new Error('That file could not be read as an Excel workbook.');
  }
  const tables = sheets.map((s) => toTable(s.sheet, s.data as unknown[][])).filter((t): t is FileTable => t !== null);
  if (tables.length === 0) throw new Error('No sheet in that workbook has a header row with column names.');
  return tables;
}

/** Applies a column mapping to a table: the rows the API's import expects. */
export function mapRows(table: FileTable, mapping: Mapping) {
  const used = (Object.entries(mapping) as [FieldKey, string][]).filter(([, col]) => col);
  return table.rows.map((r) => ({ row: r.row, values: Object.fromEntries(used.map(([f, col]) => [f, r.cells[col] ?? null])) }));
}

/** Same matching rules as the server: column names compared without case, spaces or punctuation. */
export function suggestMapping(fields: ToolField[], columns: string[]): Mapping {
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const mapping: Mapping = {};
  const taken = new Set<string>();
  for (const f of fields) {
    const wanted = new Set([squash(f.label), ...f.synonyms.map(squash)]);
    const hit = columns.find((c) => !taken.has(c) && wanted.has(squash(c)));
    if (hit) {
      mapping[f.key] = hit;
      taken.add(hit);
    }
  }
  return mapping;
}

/**
 * A new ToolTrace workbook: a "Tools" sheet with the right columns (optionally
 * filled with the current tools), and a sheet explaining each column.
 */
export async function downloadTemplate(fields: ToolField[], tools: Tool[] | null) {
  const writeXlsxFile = (await import('write-excel-file/browser')).default;
  const header = fields.map((f) => ({
    value: f.label + (f.required ? ' *' : ''),
    fontWeight: 'bold' as const,
    backgroundColor: '#2F5546',
    color: '#FFFFFF',
  }));
  const dateOf = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`) : null);
  const uid = (u: string | null) => (u ? u.match(/.{2}/g)!.join(':') : null);
  const rows = (tools ?? []).map((t) => [
    t.assetTag,
    t.name,
    t.category,
    t.homeLocationName,
    t.requiresCalibration ? t.calibrationIntervalDays : null,
    t.requiresCalibration ? dateOf(t.lastCalibratedOn) : null,
    uid(t.rfidUid),
    t.unitPrice,
    t.make,
    t.model,
  ]);
  const help = [
    [{ value: 'Column', fontWeight: 'bold' as const }, { value: 'Required', fontWeight: 'bold' as const }, { value: 'Example', fontWeight: 'bold' as const }],
    ...fields.map((f) => [f.label, f.required ? 'Yes' : 'No', f.hint]),
    [],
    ['How the import works'],
    ['Tools are matched by asset tag: a new tag adds a tool, an existing tag updates its name, category, location, RFID tag, price, make and model.'],
    ['Unit price sets the A/B/C class: A above 15,000, B from 2,000 to 15,000, C below 2,000.'],
    ['Nothing is ever deleted. Leave a cell empty to keep what ToolTrace already has.'],
    ['Calibration: enter both the interval (days, or "6 months") and the last calibration date, or neither.'],
    ['A newer "Last calibrated" date for an existing tool is recorded as a calibration, credited to this import.'],
    ['Type dates as dates (Excel date cells), or as 2026-04-15. Day-first and month-first text dates can be chosen when importing.'],
    ['Header names can be in any order; ToolTrace lets you match them when you import.'],
  ];
  await writeXlsxFile(
    [
      {
        sheet: 'Tools',
        data: [header, ...rows],
        columns: [{ width: 14 }, { width: 34 }, { width: 16 }, { width: 20 }, { width: 18 }, { width: 16 }, { width: 16 }, { width: 12 }, { width: 16 }, { width: 16 }],
        stickyRowsCount: 1,
        dateFormat: 'yyyy-mm-dd',
      },
      { sheet: 'How to fill this in', data: help, columns: [{ width: 30 }, { width: 10 }, { width: 60 }] },
    ],
  ).toFile(tools ? 'tooltrace-tools.xlsx' : 'tooltrace-tools-template.xlsx');
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const stamp = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * One register as an Excel file: the API's column names become the header row.
 * Dates stay dates, times are written as local time (yyyy-mm-dd hh:mm), yes/no stay readable.
 */
export async function downloadRows(sheet: string, rows: Record<string, unknown>[], fileName: string) {
  const writeXlsxFile = (await import('write-excel-file/browser')).default;
  const columns = rows.length ? Object.keys(rows[0]!) : ['(no rows)'];
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'number') return v;
    const s = String(v);
    if (DATE_ONLY.test(s)) return new Date(`${s}T00:00:00Z`);
    if (TIMESTAMP.test(s)) return stamp.format(new Date(s)).replace(',', '');
    return s;
  };
  const header = columns.map((c) => ({ value: c, fontWeight: 'bold' as const, backgroundColor: '#2F5546', color: '#FFFFFF' }));
  const data = rows.map((r) => columns.map((c) => cell(r[c])));
  await writeXlsxFile(
    [
      {
        sheet: sheet.slice(0, 31),
        data: [header, ...data],
        columns: columns.map((c) => ({ width: Math.min(40, Math.max(10, c.length + 4)) })),
        stickyRowsCount: 1,
        dateFormat: 'yyyy-mm-dd',
      },
    ],
  ).toFile(fileName);
}
