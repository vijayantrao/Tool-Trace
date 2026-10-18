'use client';

import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  CirclePlus,
  Database,
  FileSpreadsheet,
  FileText,
  Info,
  Plug,
  Upload,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from '@/components/toast';
import { Button, ErrorNote, Field, Input, Select } from '@/components/ui';
import { errorText } from '@/lib/api';
import {
  browseDatabase,
  browseTable,
  previewDatabaseImport,
  useCreateDataSource,
  useFileImport,
  useTools,
} from '@/lib/queries';
import { downloadTemplate, mapRows, readSpreadsheet, suggestMapping, type FileTable } from '@/lib/spreadsheet';
import type {
  ConnectionInput,
  DataSourcesInfo,
  DateOrder,
  DbKind,
  ImportResult,
  Mapping,
  RunOutcome,
  Schedule,
  SourceKind,
  TlsMode,
  ToolField,
} from '@/lib/types';

// ------------------------------------------------------------------ catalogue
export const SOURCE: Record<SourceKind, { label: string; icon: LucideIcon; tint: string }> = {
  excel: { label: 'Excel workbook', icon: FileSpreadsheet, tint: 'bg-[#1f6e43] text-white' },
  csv: { label: 'CSV file', icon: FileText, tint: 'bg-[#56645e] text-white' },
  mysql: { label: 'MySQL', icon: Database, tint: 'bg-[#1b6b8f] text-white' },
  postgres: { label: 'PostgreSQL', icon: Database, tint: 'bg-[#33568f] text-white' },
  mssql: { label: 'SQL Server', icon: Database, tint: 'bg-[#a33a2c] text-white' },
};

export type Flow = { mode: 'connect' | 'create'; kind: SourceKind };

const DB_KINDS: DbKind[] = ['mysql', 'postgres', 'mssql'];
export const isDb = (k: SourceKind): k is DbKind => DB_KINDS.includes(k as DbKind);

export function SourceIcon({ kind, size = 'md' }: { kind: SourceKind; size?: 'sm' | 'md' }) {
  const s = SOURCE[kind];
  return (
    <span className={`grid shrink-0 place-items-center rounded-lg ${s.tint} ${size === 'sm' ? 'size-9' : 'size-12'}`} aria-hidden>
      <s.icon className={size === 'sm' ? 'size-5' : 'size-6'} />
    </span>
  );
}

/** The Power Apps-style first step: what to start from. */
export function SourcePicker({
  info,
  mode,
  onMode,
  onPick,
}: {
  info: DataSourcesInfo;
  mode: 'connect' | 'create';
  onMode: (m: 'connect' | 'create') => void;
  onPick: (f: Flow) => void;
}) {
  const db = info.capabilities.databases;
  const tiles: { kind: SourceKind; text: string }[] =
    mode === 'connect'
      ? [
          { kind: 'excel', text: 'Import tools from a workbook you already keep.' },
          { kind: 'csv', text: 'Import a CSV export from any other system.' },
          { kind: 'mysql', text: 'Import from a table, once or on a schedule.' },
          { kind: 'postgres', text: 'Import from a table, once or on a schedule.' },
          { kind: 'mssql', text: 'Import from a table, once or on a schedule.' },
        ]
      : [
          { kind: 'excel', text: 'A ready-made workbook to fill in, then import.' },
          { kind: 'mysql', text: 'ToolTrace creates a table and keeps it up to date.' },
          { kind: 'postgres', text: 'ToolTrace creates a table and keeps it up to date.' },
          { kind: 'mssql', text: 'ToolTrace creates a table and keeps it up to date.' },
        ];
  const tabs = [
    { id: 'connect' as const, label: 'Connect existing data', sub: 'Bring in a tool list you already have' },
    { id: 'create' as const, label: 'Create a new data source', sub: 'Start a workbook or a database table' },
  ];
  return (
    <section aria-labelledby="start-h" className="mb-10">
      <h2 id="start-h" className="mb-3 text-xl font-semibold">
        Start with data
      </h2>
      <div role="tablist" aria-label="Start with data" className="mb-5 grid gap-2 sm:grid-cols-2">
        {tabs.map((t) => {
          const on = mode === t.id;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={on}
              onClick={() => onMode(t.id)}
              className={`rounded-lg border-2 px-4 py-3 text-left transition-colors ${
                on ? 'border-machine bg-panel' : 'border-transparent bg-board hover:border-line'
              }`}
            >
              <span className="flex items-center gap-2 font-semibold">
                {t.id === 'connect' ? <Plug className="size-4" aria-hidden /> : <CirclePlus className="size-4" aria-hidden />}
                {t.label}
              </span>
              <span className="mt-0.5 block text-sm text-muted">{t.sub}</span>
            </button>
          );
        })}
      </div>
      <div role="tabpanel" aria-label={mode === 'connect' ? 'Connect existing data' : 'Create a new data source'}>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tiles.map((t) => {
            const disabled = isDb(t.kind) && !db.enabled;
            return (
              <li key={t.kind}>
                <button
                  disabled={disabled}
                  onClick={() => onPick({ mode, kind: t.kind })}
                  className="flex h-full w-full items-start gap-3 rounded-lg border border-line bg-panel p-4 text-left transition-[border-color,box-shadow] hover:border-machine hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line disabled:hover:shadow-none"
                >
                  <SourceIcon kind={t.kind} />
                  <span className="min-w-0">
                    <span className="block font-semibold">{SOURCE[t.kind].label}</span>
                    <span className="mt-0.5 block text-sm text-muted">{t.text}</span>
                  </span>
                  <span className="sr-only">{mode === 'connect' ? 'Connect existing' : 'Create new'}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {!db.enabled && (
          <p className="mt-3 flex items-start gap-2 text-sm text-muted">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            {db.reason}
          </p>
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ shared parts
function Steps({ steps, at }: { steps: string[]; at: number }) {
  return (
    <ol className="mb-6 flex flex-wrap gap-x-5 gap-y-2 text-sm" aria-label="Steps">
      {steps.map((s, i) => (
        <li key={s} aria-current={i === at ? 'step' : undefined} className={`flex items-center gap-2 ${i === at ? 'font-semibold text-ink' : 'text-muted'}`}>
          <span
            className={`grid size-6 place-items-center rounded-full text-xs font-bold ${
              i < at ? 'bg-ok text-white' : i === at ? 'bg-machine text-machine-ink' : 'bg-board ring-1 ring-line'
            }`}
          >
            {i < at ? '✓' : i + 1}
          </span>
          {s}
        </li>
      ))}
    </ol>
  );
}

export function WizardFrame({ title, kind, onClose, children }: { title: string; kind: SourceKind; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  // Braces matter: newer browsers return a Promise from scrollIntoView, and React would call it as a cleanup.
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);
  return (
    <section ref={ref} aria-label={title} className="mb-10 scroll-mt-6 rounded-xl border border-line bg-panel">
      <header className="flex items-center gap-3 border-b border-line px-5 py-4">
        <SourceIcon kind={kind} size="sm" />
        <h2 className="flex-1 text-xl font-semibold">{title}</h2>
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
      </header>
      <div className="px-5 py-5">{children}</div>
    </section>
  );
}

/** Which column feeds which ToolTrace field, with a sample value from the data. */
function MappingEditor({
  fields,
  columns,
  sample,
  mapping,
  onChange,
}: {
  fields: ToolField[];
  columns: string[];
  sample: Record<string, unknown> | undefined;
  mapping: Mapping;
  onChange: (m: Mapping) => void;
}) {
  const id = useId();
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="hidden grid-cols-[minmax(10rem,1fr)_minmax(12rem,1.2fr)_minmax(8rem,1fr)] gap-4 bg-board px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted sm:grid">
        <span>ToolTrace field</span>
        <span>Column in your data</span>
        <span>First value</span>
      </div>
      <ul className="divide-y divide-line">
        {fields.map((f) => {
          const col = mapping[f.key] ?? '';
          const value = col && sample ? sample[col] : undefined;
          return (
            <li key={f.key} className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(10rem,1fr)_minmax(12rem,1.2fr)_minmax(8rem,1fr)] sm:items-center sm:gap-4">
              <label htmlFor={`${id}-${f.key}`} className="font-medium">
                {f.label}
                {f.required && <span className="ml-1.5 rounded bg-safety px-1.5 py-0.5 text-[0.7rem] font-bold text-safety-ink">Required</span>}
              </label>
              <Select id={`${id}-${f.key}`} value={col} onChange={(e) => onChange({ ...mapping, [f.key]: e.target.value || undefined })}>
                <option value="">{f.required ? 'Choose a column…' : 'Not in my data'}</option>
                {columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
              <span className="truncate text-sm text-muted" title={value == null ? '' : String(value)}>
                {col ? (value == null || value === '' ? '(empty)' : String(value)) : `e.g. ${f.hint}`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const missingRequired = (fields: ToolField[], m: Mapping) => fields.filter((f) => f.required && !m[f.key]).map((f) => f.label);

function DateOrderPicker({ value, onChange }: { value: DateOrder; onChange: (d: DateOrder) => void }) {
  const id = useId();
  return (
    <Field label="Dates written as text" htmlFor={id} hint="Only matters for dates typed as text. Real Excel and database dates are read exactly.">
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value as DateOrder)}>
        <option value="dmy">31/12/2026: day first</option>
        <option value="mdy">12/31/2026: month first</option>
      </Select>
    </Field>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'warn' }) {
  return (
    <div className="rounded-lg border border-line bg-board/60 px-4 py-3">
      <div className="text-sm text-muted">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums ${tone === 'warn' && value ? 'text-signal' : ''}`}>{value}</div>
    </div>
  );
}

/** What an import did, or would do. */
export function ImportResultView({ result, dry }: { result: ImportResult; dry: boolean }) {
  const errors = result.problems.filter((p) => p.level === 'error');
  const warnings = result.problems.filter((p) => p.level === 'warning');
  return (
    <div className="flex flex-col gap-4" role="region" aria-label={dry ? 'Check results' : 'Import results'}>
      <p className="font-semibold">
        {dry ? `Checked ${result.rows} rows. Nothing has changed yet.` : `Imported ${result.rows} rows.`}
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={dry ? 'Will be added' : 'Added'} value={result.created} />
        <Stat label={dry ? 'Will be updated' : 'Updated'} value={result.updated} />
        <Stat label="Unchanged" value={result.unchanged} />
        <Stat label="Skipped" value={result.skipped} tone="warn" />
      </div>
      {(result.calibrationsRecorded > 0 || result.locationsCreated.length > 0) && (
        <ul className="list-disc pl-5 text-sm text-muted">
          {result.calibrationsRecorded > 0 && (
            <li>
              {result.calibrationsRecorded} newer calibration{result.calibrationsRecorded === 1 ? '' : 's'} {dry ? 'will be' : 'were'} recorded,
              credited to this import.
            </li>
          )}
          {result.locationsCreated.length > 0 && (
            <li>
              New location{result.locationsCreated.length === 1 ? '' : 's'}: {result.locationsCreated.join(', ')}.
            </li>
          )}
        </ul>
      )}
      {result.problems.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-line">
          <div className="bg-board px-4 py-2 text-sm font-semibold">
            {errors.length > 0 && `${errors.length} row${errors.length === 1 ? '' : 's'} skipped`}
            {errors.length > 0 && warnings.length > 0 && ' · '}
            {warnings.length > 0 && `${warnings.length} note${warnings.length === 1 ? '' : 's'}`}
          </div>
          <ul className="max-h-72 divide-y divide-line overflow-auto text-sm">
            {result.problems.map((p, i) => (
              <li key={i} className="flex gap-3 px-4 py-2">
                {p.level === 'error' ? (
                  <XCircle className="mt-0.5 size-4 shrink-0 text-signal" aria-label="Skipped" />
                ) : (
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[#a87b00]" aria-label="Note" />
                )}
                <span className="w-16 shrink-0 tabular-nums text-muted">Row {p.row}</span>
                {p.assetTag && <span className="tag-plate w-24 shrink-0 truncate">{p.assetTag}</span>}
                <span className="min-w-0 flex-1">{p.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Excel: create
export function ExcelTemplate({ info, onClose }: { info: DataSourcesInfo; onClose: () => void }) {
  const tools = useTools();
  const [withTools, setWithTools] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const count = tools.data?.length ?? 0;
  return (
    <WizardFrame title="Create a new Excel workbook" kind="excel" onClose={onClose}>
      <p className="mb-5 max-w-2xl text-muted">
        A workbook with the columns ToolTrace understands, frozen headers, and a sheet explaining each column. Fill it in (or
        hand it to whoever keeps the tool list), then bring it back with <b>Connect existing data → Excel workbook</b>.
      </p>
      <fieldset className="mb-5 flex flex-col gap-2">
        <legend className="mb-2 text-sm font-semibold">Start the workbook</legend>
        {[
          { v: true, label: `With the ${count} tools already in ToolTrace`, sub: 'Edit them in Excel and import the changes back.' },
          { v: false, label: 'Empty, with just the column headers', sub: 'For a first tool list.' },
        ].map((o) => (
          <label key={String(o.v)} className={`flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 ${withTools === o.v ? 'border-machine bg-board/60' : 'border-line'}`}>
            <input type="radio" name="template" className="mt-1 accent-[var(--machine)]" checked={withTools === o.v} onChange={() => setWithTools(o.v)} />
            <span>
              <span className="block font-medium">{o.label}</span>
              <span className="block text-sm text-muted">{o.sub}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <ErrorNote>{error}</ErrorNote>
      <Button
        busy={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            await downloadTemplate(info.fields, withTools ? (tools.data ?? []) : null);
            toast('Workbook downloaded');
          } catch {
            setError('The workbook could not be created in this browser.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <FileSpreadsheet className="size-4" aria-hidden /> Download workbook
      </Button>
    </WizardFrame>
  );
}

// ------------------------------------------------------------------ Excel / CSV: import
export function FileImport({ kind, info, onClose }: { kind: 'excel' | 'csv'; info: DataSourcesInfo; onClose: () => void }) {
  const inputId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [tables, setTables] = useState<FileTable[]>([]);
  const [sheet, setSheet] = useState(0);
  const [mapping, setMapping] = useState<Mapping>({});
  const [dateOrder, setDateOrder] = useState<DateOrder>('dmy');
  const [checked, setChecked] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const run = useFileImport();
  const table = tables[sheet];
  const missing = missingRequired(info.fields, mapping);
  const tooMany = table ? table.rows.length > info.capabilities.maxFileRows : false;

  const open = async (f: File) => {
    setError('');
    setChecked(null);
    try {
      const t = await readSpreadsheet(f);
      const first = Math.max(0, t.findIndex((x) => x.sheet.toLowerCase() === 'tools'));
      setFile(f);
      setTables(t);
      setSheet(first);
      setMapping(suggestMapping(info.fields, t[first]!.columns));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const send = (dryRun: boolean) =>
    run.mutateAsync({
      fileName: file!.name.slice(0, 200),
      fileKind: /\.csv$/i.test(file!.name) ? 'csv' : 'excel',
      dateOrder,
      dryRun,
      rows: mapRows(table!, mapping),
    });

  const step = done ? 3 : checked ? 2 : file ? 1 : 0;
  return (
    <WizardFrame title={`Import from ${kind === 'csv' ? 'a CSV file' : 'an Excel workbook'}`} kind={kind} onClose={onClose}>
      <Steps steps={['Choose the file', 'Match the columns', 'Check', 'Import']} at={step} />

      {!file && (
        <label
          htmlFor={inputId}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files[0];
            if (f) void open(f);
          }}
          className={`flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-12 text-center ${dragging ? 'border-machine bg-board' : 'border-line'}`}
        >
          <Upload className="size-8 text-muted" aria-hidden />
          <span className="font-semibold">Choose a file, or drop it here</span>
          <span className="text-sm text-muted">
            {kind === 'csv' ? 'A .csv file' : 'An .xlsx workbook'}, up to {info.capabilities.maxFileRows.toLocaleString()} tools. It is read on
            this computer; only the matched columns are sent.
          </span>
          <input
            id={inputId}
            type="file"
            aria-label="Spreadsheet file"
            accept={kind === 'csv' ? '.csv,text/csv' : '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void open(f);
            }}
          />
        </label>
      )}
      <ErrorNote>{error}</ErrorNote>

      {file && table && !done && (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-end gap-4">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-muted">File</div>
              <div className="truncate font-semibold">
                {file.name} · {table.rows.length.toLocaleString()} row{table.rows.length === 1 ? '' : 's'}
              </div>
            </div>
            {tables.length > 1 && (
              <div className="w-56">
                <Field label="Sheet" htmlFor={`${inputId}-sheet`}>
                  <Select
                    id={`${inputId}-sheet`}
                    value={sheet}
                    onChange={(e) => {
                      const i = Number(e.target.value);
                      setSheet(i);
                      setMapping(suggestMapping(info.fields, tables[i]!.columns));
                      setChecked(null);
                    }}
                  >
                    {tables.map((t, i) => (
                      <option key={t.sheet} value={i}>
                        {t.sheet}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
            <Button
              variant="quiet"
              onClick={() => {
                setFile(null);
                setTables([]);
                setChecked(null);
              }}
            >
              Choose another file
            </Button>
          </div>

          <MappingEditor
            fields={info.fields}
            columns={table.columns}
            sample={table.rows[0]?.cells}
            mapping={mapping}
            onChange={(m) => {
              setMapping(m);
              setChecked(null);
            }}
          />
          <div className="max-w-sm">
            <DateOrderPicker value={dateOrder} onChange={(d) => { setDateOrder(d); setChecked(null); }} />
          </div>

          {tooMany && <ErrorNote>This sheet has {table.rows.length.toLocaleString()} rows. Import up to {info.capabilities.maxFileRows.toLocaleString()} at a time.</ErrorNote>}
          {missing.length > 0 && <p className="text-sm text-muted">Choose a column for {missing.join(' and ')} to continue.</p>}
          {run.isError && <ErrorNote>{errorText(run.error)}</ErrorNote>}

          {!checked ? (
            <div>
              <Button
                busy={run.isPending}
                disabled={missing.length > 0 || tooMany}
                onClick={async () => {
                  try {
                    setChecked((await send(true)).result);
                  } catch {
                    /* shown above */
                  }
                }}
              >
                Check {table.rows.length.toLocaleString()} rows
              </Button>
            </div>
          ) : (
            <>
              <ImportResultView result={checked} dry />
              <div className="flex flex-wrap gap-2">
                <Button
                  busy={run.isPending}
                  disabled={checked.created + checked.updated === 0}
                  onClick={async () => {
                    try {
                      const r = (await send(false)).result;
                      setDone(r);
                      toast(`Imported: ${r.created} added, ${r.updated} updated`);
                    } catch {
                      /* shown above */
                    }
                  }}
                >
                  Import {checked.created + checked.updated} tool{checked.created + checked.updated === 1 ? '' : 's'}
                </Button>
                <Button variant="quiet" onClick={() => setChecked(null)}>
                  <ArrowLeft className="size-4" aria-hidden /> Change the matching
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {done && (
        <div className="flex flex-col gap-4">
          <ImportResultView result={done} dry={false} />
          <div>
            <Button
              variant="quiet"
              onClick={() => {
                setDone(null);
                setChecked(null);
                setFile(null);
                setTables([]);
              }}
            >
              Import another file
            </Button>
          </div>
        </div>
      )}
    </WizardFrame>
  );
}

// ------------------------------------------------------------------ databases
const TLS_OPTIONS: { v: TlsMode; label: string }[] = [
  { v: 'verify', label: 'Encrypted, certificate checked (recommended)' },
  { v: 'require', label: 'Encrypted, certificate not checked (self-signed)' },
  { v: 'off', label: 'Not encrypted (only inside a trusted network)' },
];

function ConnectionForm({
  kind,
  info,
  busy,
  onConnect,
}: {
  kind: DbKind;
  info: DataSourcesInfo;
  busy: boolean;
  onConnect: (c: ConnectionInput) => void;
}) {
  const id = useId();
  const [c, setC] = useState<ConnectionInput>({ kind, host: '', database: '', username: '', password: '', tls: 'verify' });
  const [port, setPort] = useState('');
  const set = (k: keyof ConnectionInput) => (e: { target: { value: string } }) => setC({ ...c, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onConnect({ ...c, port: port ? Number(port) : undefined });
  };
  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-6" autoComplete="off">
      <div className="sm:col-span-4">
        <Field label="Server" htmlFor={`${id}-host`} hint="Host name or IP address, e.g. db.plant.local">
          <Input id={`${id}-host`} required value={c.host} onChange={set('host')} autoCapitalize="none" spellCheck={false} />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field label="Port" htmlFor={`${id}-port`}>
          <Input id={`${id}-port`} inputMode="numeric" pattern="[0-9]*" placeholder={String(info.capabilities.defaultPorts[kind])} value={port} onChange={(e) => setPort(e.target.value)} />
        </Field>
      </div>
      <div className="sm:col-span-6">
        <Field label="Database" htmlFor={`${id}-db`}>
          <Input id={`${id}-db`} required value={c.database} onChange={set('database')} autoCapitalize="none" spellCheck={false} />
        </Field>
      </div>
      <div className="sm:col-span-3">
        <Field label="User name" htmlFor={`${id}-user`}>
          <Input id={`${id}-user`} required value={c.username} onChange={set('username')} autoCapitalize="none" spellCheck={false} />
        </Field>
      </div>
      <div className="sm:col-span-3">
        <Field label="Password" htmlFor={`${id}-pw`} hint="Stored encrypted. Never shown again.">
          <Input id={`${id}-pw`} type="password" autoComplete="new-password" value={c.password} onChange={set('password')} />
        </Field>
      </div>
      <div className="sm:col-span-6">
        <Field label="Encryption" htmlFor={`${id}-tls`}>
          <Select id={`${id}-tls`} value={c.tls} onChange={set('tls')}>
            {TLS_OPTIONS.map((o) => (
              <option key={o.v} value={o.v}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="sm:col-span-6">
        <Button type="submit" busy={busy}>
          <Plug className="size-4" aria-hidden /> Connect
        </Button>
      </div>
    </form>
  );
}

function ScheduleField({ value, onChange, mode }: { value: Schedule; onChange: (s: Schedule) => void; mode: 'import' | 'mirror' }) {
  const id = useId();
  return (
    <Field label={mode === 'import' ? 'Import again' : 'Update the copy'} htmlFor={id}>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value as Schedule)}>
        <option value="manual">Only when I click “Sync now”</option>
        <option value="hourly">Every hour</option>
        <option value="daily">Every day</option>
      </Select>
    </Field>
  );
}

function OutcomeView({ outcome }: { outcome: RunOutcome }) {
  return (
    <div className="flex flex-col gap-4">
      <p className={`flex items-center gap-2 font-semibold ${outcome.ok ? '' : 'text-signal'}`}>
        {outcome.ok ? <CheckCircle2 className="size-5 text-ok" aria-hidden /> : <XCircle className="size-5" aria-hidden />}
        {outcome.message}
      </p>
      {outcome.import && <ImportResultView result={outcome.import} dry={false} />}
    </div>
  );
}

export function DatabaseWizard({ kind, mode, info, onClose }: { kind: DbKind; mode: 'import' | 'mirror'; info: DataSourcesInfo; onClose: () => void }) {
  const id = useId();
  const [connection, setConnection] = useState<ConnectionInput | null>(null);
  const [tables, setTables] = useState<string[]>([]);
  const [table, setTable] = useState('');
  const [columns, setColumns] = useState<string[]>([]);
  const [preview, setPreview] = useState<Record<string, unknown>[]>([]);
  const [mapping, setMapping] = useState<Mapping>({});
  const [dateOrder, setDateOrder] = useState<DateOrder>('dmy');
  const [checked, setChecked] = useState<ImportResult | null>(null);
  const [name, setName] = useState('');
  const [newTable, setNewTable] = useState('tooltrace_tools');
  const [schedule, setSchedule] = useState<Schedule>(mode === 'mirror' ? 'hourly' : 'daily');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const create = useCreateDataSource();
  const label = SOURCE[kind].label;

  const attempt = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const connect = (c: ConnectionInput) =>
    attempt(async () => {
      const r = await browseDatabase(c);
      setConnection(c);
      setTables(r.tables);
      setName(mode === 'mirror' ? `${label} · ${c.database} (copy)` : `${label} · ${c.database}`);
    });

  const chooseTable = (t: string) => {
    setTable(t);
    setChecked(null);
    if (!t) return;
    void attempt(async () => {
      const r = await browseTable(connection!, t);
      setColumns(r.columns.map((c) => c.name));
      setPreview(r.preview);
      setMapping(r.suggested);
    });
  };

  const steps = mode === 'import' ? ['Connect', 'Choose a table', 'Match the columns', 'Check and save'] : ['Connect', 'Name the copy', 'Create and copy'];
  const at = outcome ? steps.length : !connection ? 0 : mode === 'mirror' ? 1 : !columns.length ? 1 : !checked ? 2 : 3;
  const missing = missingRequired(info.fields, mapping);
  const previewCols = useMemo(() => columns.slice(0, 8), [columns]);

  return (
    <WizardFrame title={mode === 'import' ? `Import from ${label}` : `Create a ToolTrace table in ${label}`} kind={kind} onClose={onClose}>
      <Steps steps={steps} at={Math.min(at, steps.length - 1)} />
      {!connection && (
        <>
          <p className="mb-5 max-w-2xl text-muted">
            {mode === 'import'
              ? 'ToolTrace reads the table you choose and adds or updates tools by asset tag. It never writes to your database.'
              : 'ToolTrace creates one table and refreshes it with every tool, where it is, who has it and its calibration. Handy for Power BI and other reports.'}{' '}
            Use a database account that has only the rights it needs ({mode === 'import' ? 'read' : 'create and write one table'}).
          </p>
          <ConnectionForm kind={kind} info={info} busy={busy} onConnect={connect} />
        </>
      )}
      <div className="mt-4">
        <ErrorNote>{error}</ErrorNote>
      </div>

      {connection && !outcome && mode === 'import' && (
        <div className="flex flex-col gap-5">
          <p className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="size-4 text-ok" aria-hidden /> Connected to <b>{connection.database}</b> on {connection.host}.
          </p>
          <div className="max-w-md">
            <Field label="Table" htmlFor={`${id}-table`}>
              <Select id={`${id}-table`} value={table} onChange={(e) => chooseTable(e.target.value)}>
                <option value="">Choose a table…</option>
                {tables.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {columns.length > 0 && (
            <>
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-left text-sm">
                  <caption className="bg-board px-4 py-2 text-left font-semibold">First rows of {table}</caption>
                  <thead>
                    <tr className="border-b border-line">
                      {previewCols.map((c) => (
                        <th key={c} scope="col" className="whitespace-nowrap px-3 py-2 font-semibold">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((r, i) => (
                      <tr key={i} className="border-b border-line last:border-0">
                        {previewCols.map((c) => (
                          <td key={c} className="max-w-48 truncate whitespace-nowrap px-3 py-2 text-muted">
                            {r[c] == null ? '' : String(r[c])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <MappingEditor fields={info.fields} columns={columns} sample={preview[0]} mapping={mapping} onChange={(m) => { setMapping(m); setChecked(null); }} />
              <div className="max-w-sm">
                <DateOrderPicker value={dateOrder} onChange={(d) => { setDateOrder(d); setChecked(null); }} />
              </div>
              {missing.length > 0 && <p className="text-sm text-muted">Choose a column for {missing.join(' and ')} to continue.</p>}
              {!checked ? (
                <div>
                  <Button
                    busy={busy}
                    disabled={missing.length > 0}
                    onClick={() => attempt(async () => setChecked((await previewDatabaseImport({ connection, table, mapping, dateOrder })).result))}
                  >
                    Check the table
                  </Button>
                </div>
              ) : (
                <>
                  <ImportResultView result={checked} dry />
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Name for this connection" htmlFor={`${id}-name`}>
                      <Input id={`${id}-name`} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
                    </Field>
                    <ScheduleField value={schedule} onChange={setSchedule} mode="import" />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      busy={busy || create.isPending}
                      disabled={!name.trim()}
                      onClick={() =>
                        attempt(async () => {
                          const r = await create.mutateAsync({ name: name.trim(), mode: 'import', connection, table, mapping, dateOrder, schedule });
                          setOutcome(r.run);
                          toast(r.run.ok ? 'Connection saved and imported' : 'Saved, but the import failed', r.run.ok ? 'ok' : 'error');
                        })
                      }
                    >
                      Save and import
                    </Button>
                    <Button variant="quiet" onClick={() => setChecked(null)}>
                      <ArrowLeft className="size-4" aria-hidden /> Change the matching
                    </Button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {connection && !outcome && mode === 'mirror' && (
        <div className="flex max-w-2xl flex-col gap-5">
          <p className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="size-4 text-ok" aria-hidden /> Connected to <b>{connection.database}</b> on {connection.host}.
          </p>
          <Field label="New table name" htmlFor={`${id}-new`} hint="Letters, digits and _ only. If ToolTrace made this table before, it is reused.">
            <Input id={`${id}-new`} value={newTable} maxLength={63} pattern="[A-Za-z_][A-Za-z0-9_]*" onChange={(e) => setNewTable(e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name for this connection" htmlFor={`${id}-mname`}>
              <Input id={`${id}-mname`} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            </Field>
            <ScheduleField value={schedule} onChange={setSchedule} mode="mirror" />
          </div>
          <div>
            <Button
              busy={busy || create.isPending}
              disabled={!name.trim() || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(newTable)}
              onClick={() =>
                attempt(async () => {
                  const r = await create.mutateAsync({ name: name.trim(), mode: 'mirror', connection, table: newTable, dateOrder, schedule });
                  setOutcome(r.run);
                  toast(r.run.ok ? `Table ${newTable} created` : 'Saved, but the copy failed', r.run.ok ? 'ok' : 'error');
                })
              }
            >
              <Database className="size-4" aria-hidden /> Create table and copy tools
            </Button>
          </div>
        </div>
      )}

      {outcome && <OutcomeView outcome={outcome} />}
    </WizardFrame>
  );
}
