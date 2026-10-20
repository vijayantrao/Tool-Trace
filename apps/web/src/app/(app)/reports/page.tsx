'use client';

import Link from 'next/link';
import { Download, FileCheck2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ColumnBars, HorizontalBars } from '@/components/bar-chart';
import { toast } from '@/components/toast';
import { Button, ErrorNote, Field, Input, PageHeader, Panel, Spinner } from '@/components/ui';
import { errorText } from '@/lib/api';
import { formatShortDay, todayIso } from '@/lib/format';
import { useMoney } from '@/lib/meta';
import { fetchExport, useReportSummary } from '@/lib/queries';
import { useMe } from '@/lib/session';
import { downloadRows } from '@/lib/spreadsheet';
import type { ExportDataset } from '@/lib/types';

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const monthName = (ym: string) => new Intl.DateTimeFormat(undefined, { month: 'short' }).format(new Date(`${ym}-01T00:00:00`));

function Tile({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: 'signal' }) {
  return (
    <div className="rounded-lg border border-line bg-panel p-4">
      <div className="text-sm text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone === 'signal' ? 'text-signal' : ''}`}>{value}</div>
      {note && <div className="mt-0.5 text-sm text-muted">{note}</div>}
    </div>
  );
}

export default function ReportsPage() {
  const { data: s, isLoading, isError, error } = useReportSummary();
  const money = useMoney();
  if (isLoading) return <Spinner />;
  if (isError || !s) return <ErrorNote>{errorText(error)}</ErrorNote>;
  const classValue = (c: string) => s.byClass.find((x) => x.class === c);

  return (
    <>
      <PageHeader
        title="Reports"
        sub="What the crib is worth, how it is used, and every register as an Excel file."
        actions={
          <Link
            href="/reports/calibration"
            className="inline-flex min-h-11 items-center gap-2 rounded-md px-4 font-semibold ring-1 ring-inset ring-line hover:bg-panel"
          >
            <FileCheck2 className="size-4" aria-hidden /> Calibration register
          </Link>
        }
      />

      <section aria-label="Totals" className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Tools in service" value={money(s.tools.value)} note={`${count(s.tools.count, 'tool')}${s.tools.unpriced ? `, ${s.tools.unpriced} without a price` : ''}`} />
        <Tile label="Out on the floor" value={money(s.tools.valueOut)} note={count(s.tools.out, 'tool')} />
        <Tile label="Overdue" value={money(s.tools.valueOverdue)} tone={s.tools.valueOverdue ? 'signal' : undefined} note="Value of tools past their due time" />
        <Tile label="Off the board" value={money(s.tools.valueQuarantined + s.tools.valueAtLab)} note={`Quarantined ${money(s.tools.valueQuarantined)}, at the lab ${money(s.tools.valueAtLab)}`} />
        <Tile label="PPE and stock" value={money(s.stock.value)} note={`${count(s.stock.items, 'item')}, ${s.stock.low} to reorder`} tone={s.stock.low ? 'signal' : undefined} />
        <Tile label="Calibration" value={`${s.calibration.dueSoon} due`} note={`${s.calibration.expired} locked, ${s.calibration.atLab} at the lab`} tone={s.calibration.expired ? 'signal' : undefined} />
        <Tile label="Open requests" value={s.openRequests} note={s.approvedCost ? `${money(s.approvedCost)} approved, not yet fulfilled` : undefined} />
        <Tile label="Issues to confirm" value={s.pendingAcks} note={s.disputedAcks ? `${s.disputedAcks} disputed` : 'None disputed'} tone={s.disputedAcks ? 'signal' : undefined} />
      </section>

      <div className="mb-8 grid gap-5 lg:grid-cols-2">
        <Panel className="p-5">
          <h2 className="text-xl font-semibold">Value by category</h2>
          <p className="mb-4 text-sm text-muted">Tools in service, by unit price.</p>
          <HorizontalBars
            caption="Value of tools by category"
            bars={s.byCategory.map((c) => ({ key: c.category, label: c.category, value: c.value, detail: `${money(c.value)} (${c.count})` }))}
          />
        </Panel>
        <Panel className="p-5">
          <h2 className="text-xl font-semibold">A/B/C class</h2>
          <p className="mb-4 text-sm text-muted">A: above 15,000. B: 2,000 to 15,000. C: below 2,000.</p>
          <div className="grid grid-cols-2 gap-3">
            {(['A', 'B', 'C', 'none'] as const).map((c) => {
              const v = classValue(c);
              return (
                <div key={c} className="rounded-md bg-board p-3">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    {c === 'none' ? <span className="text-muted">No price yet</span> : <span className="rounded bg-ink px-1.5 text-panel">{c}</span>}
                  </div>
                  <div className="mt-1 text-xl font-semibold tabular-nums">{count(v?.count ?? 0, 'tool')}</div>
                  {c !== 'none' && <div className="text-sm tabular-nums text-muted">{money(v?.value ?? 0)}</div>}
                </div>
              );
            })}
          </div>
        </Panel>
        <Panel className="p-5">
          <h2 className="text-xl font-semibold">Check-outs per week</h2>
          <p className="mb-6 text-sm text-muted">The last 12 weeks, Monday to Sunday.</p>
          <ColumnBars
            caption="Check-outs per week"
            bars={s.weekly.map((w) => ({
              key: w.week,
              label: formatShortDay(w.week),
              value: w.checkouts,
              detail: `${w.checkouts} check-outs, ${w.lateReturns} returned late`,
            }))}
          />
        </Panel>
        <Panel className="p-5">
          <h2 className="text-xl font-semibold">Calibration due</h2>
          <p className="mb-6 text-sm text-muted">
            Tools whose calibration runs out in each of the next six months.
            {s.calibration.expired ? ` ${s.calibration.expired} already expired.` : ''}
          </p>
          <ColumnBars
            caption="Calibrations due per month"
            bars={s.calibrationDue.map((m) => ({ key: m.month, label: monthName(m.month), value: m.count, detail: count(m.count, 'tool') }))}
          />
        </Panel>
      </div>

      <Exports />
    </>
  );
}

const datasets: { id: ExportDataset; label: string; ranged: boolean; auditOnly?: boolean }[] = [
  { id: 'tools', label: 'Tool register', ranged: false },
  { id: 'checkouts', label: 'Check-out history', ranged: true },
  { id: 'calibrations', label: 'Calibration history', ranged: true },
  { id: 'stock', label: 'PPE and stock list', ranged: false },
  { id: 'movements', label: 'Stock movements', ranged: true },
  { id: 'requests', label: 'Requests', ranged: true },
  { id: 'audit', label: 'Audit trail', ranged: true, auditOnly: true },
];

function Exports() {
  const { data: me } = useMe();
  const [from, setFrom] = useState(() => {
    const d = new Date(Date.now() - 90 * 86_400_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [to, setTo] = useState(todayIso());
  const [busy, setBusy] = useState<ExportDataset | null>(null);

  const run = async (d: (typeof datasets)[number]) => {
    setBusy(d.id);
    try {
      const res = await fetchExport(d.id, d.ranged ? { from, to } : {});
      const stamp = d.ranged ? `${from}-to-${to}` : todayIso();
      await downloadRows(res.title, res.rows, `tooltrace-${d.id}-${stamp}.xlsx`);
      toast(`${res.title}: ${res.rows.length} rows${res.truncated ? ' (the first 20,000: narrow the dates for the rest)' : ''}`);
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel className="p-5">
      <h2 className="text-xl font-semibold">Download as Excel</h2>
      <p className="mb-4 text-sm text-muted">Histories use the dates below; lists are as they stand today.</p>
      <div className="mb-5 grid max-w-md grid-cols-2 gap-3">
        <Field label="From" htmlFor="from">
          <Input id="from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To" htmlFor="to">
          <Input id="to" type="date" value={to} min={from} max={todayIso()} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        {datasets
          .filter((d) => !d.auditOnly || me?.role === 'admin' || me?.role === 'auditor')
          .map((d) => (
            <Button key={d.id} variant="quiet" busy={busy === d.id} disabled={busy !== null && busy !== d.id} onClick={() => run(d)}>
              <Download className="size-4" aria-hidden /> {d.label}
            </Button>
          ))}
      </div>
    </Panel>
  );
}
