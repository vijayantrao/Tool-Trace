'use client';

import { CheckCircle2, Clock, RefreshCw, Trash2, XCircle } from 'lucide-react';
import { useState } from 'react';
import {
  DatabaseWizard,
  ExcelTemplate,
  FileImport,
  isDb,
  SOURCE,
  SourceIcon,
  SourcePicker,
  type Flow,
} from '@/components/data-sources';
import { toast } from '@/components/toast';
import { Button, ErrorNote, PageHeader, Select, Spinner } from '@/components/ui';
import { errorText } from '@/lib/api';
import { relative } from '@/lib/format';
import { useDataSources, useRemoveDataSource, useSyncDataSource, useUpdateDataSource } from '@/lib/queries';
import { can, useMe } from '@/lib/session';
import type { DataSource, Schedule, SyncRun } from '@/lib/types';

export default function DataSourcesPage() {
  const { data: me } = useMe();
  const allowed = can.manageData(me?.role);
  const info = useDataSources(allowed);
  const [mode, setMode] = useState<'connect' | 'create'>('connect');
  const [flow, setFlow] = useState<Flow | null>(null);

  if (!allowed) return <ErrorNote>Only admins can manage data sources.</ErrorNote>;
  if (info.isLoading) return <Spinner label="Loading data sources" />;
  if (info.isError) return <ErrorNote>{errorText(info.error)}</ErrorNote>;
  const data = info.data!;
  const close = () => setFlow(null);

  return (
    <>
      <PageHeader
        title="Data sources"
        sub="Bring your tool list in from Excel or a database, or keep a copy of ToolTrace's tools in one. ToolTrace stays the record: every import is checked, and audited like a change made by hand."
      />

      <SourcePicker
        info={data}
        mode={mode}
        onMode={(m) => {
          setMode(m);
          setFlow(null);
        }}
        onPick={setFlow}
      />

      {flow?.kind === 'excel' && flow.mode === 'create' && <ExcelTemplate info={data} onClose={close} />}
      {flow && (flow.kind === 'excel' || flow.kind === 'csv') && flow.mode === 'connect' && (
        <FileImport key={flow.kind} kind={flow.kind} info={data} onClose={close} />
      )}
      {flow && isDb(flow.kind) && (
        <DatabaseWizard
          key={`${flow.mode}-${flow.kind}`}
          kind={flow.kind}
          mode={flow.mode === 'connect' ? 'import' : 'mirror'}
          info={data}
          onClose={close}
        />
      )}

      <section aria-labelledby="saved-h" className="mb-10">
        <h2 id="saved-h" className="mb-3 text-xl font-semibold">
          Database connections
        </h2>
        {data.sources.length === 0 ? (
          <p className="rounded-lg border border-line bg-panel px-4 py-6 text-center text-muted">
            None yet. Connect a database above to import from it, or create a ToolTrace table in one.
          </p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
            {data.sources.map((s) => (
              <SourceRow key={s.id} source={s} canSync={data.capabilities.databases.enabled} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="runs-h">
        <h2 id="runs-h" className="mb-3 text-xl font-semibold">
          Recent imports and copies
        </h2>
        {data.runs.length === 0 ? (
          <p className="rounded-lg border border-line bg-panel px-4 py-6 text-center text-muted">Nothing imported yet.</p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
            {data.runs.map((r) => (
              <RunRow key={r.id} run={r} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function SourceRow({ source: s, canSync }: { source: DataSource; canSync: boolean }) {
  const sync = useSyncDataSource();
  const update = useUpdateDataSource();
  const remove = useRemoveDataSource();
  const [confirm, setConfirm] = useState(false);
  const error = sync.error ?? update.error ?? remove.error;
  return (
    <li className="flex flex-col gap-3 px-4 py-4 lg:flex-row lg:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <SourceIcon kind={s.kind} size="sm" />
        <div className="min-w-0">
          <div className="font-semibold">{s.name}</div>
          <div className="text-sm text-muted">
            {s.mode === 'import' ? 'Imports tools from' : 'Keeps a copy in'} <b className="font-medium text-ink">{s.tableName}</b> ·{' '}
            {SOURCE[s.kind].label} · {s.host}/{s.databaseName}
          </div>
          {s.lastSyncAt && (
            <div className={`mt-1 flex items-start gap-1.5 text-sm ${s.lastSyncOk ? 'text-muted' : 'text-signal'}`}>
              {s.lastSyncOk ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden /> : <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />}
              <span>
                {relative(s.lastSyncAt)}: {s.lastSyncMessage}
              </span>
            </div>
          )}
          {s.nextSyncAt && (
            <div className="mt-0.5 flex items-center gap-1.5 text-sm text-muted">
              <Clock className="size-4" aria-hidden /> Next {relative(s.nextSyncAt)}
            </div>
          )}
          {error && (
            <div className="mt-2">
              <ErrorNote>{errorText(error)}</ErrorNote>
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label={`Schedule for ${s.name}`}
          className="!w-auto"
          value={s.schedule}
          onChange={(e) => update.mutate({ id: s.id, schedule: e.target.value as Schedule }, { onSuccess: () => toast('Schedule saved') })}
        >
          <option value="manual">Manual</option>
          <option value="hourly">Every hour</option>
          <option value="daily">Every day</option>
        </Select>
        <Button
          variant="quiet"
          busy={sync.isPending}
          disabled={!canSync}
          onClick={() =>
            sync.mutate(s.id, { onSuccess: (r) => toast(r.run.message, r.run.ok ? 'ok' : 'error') })
          }
        >
          <RefreshCw className="size-4" aria-hidden /> Sync now
        </Button>
        {confirm ? (
          <>
            <Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate(s.id, { onSuccess: () => toast(`Removed ${s.name}`) })}>
              Remove
            </Button>
            <Button variant="quiet" onClick={() => setConfirm(false)}>
              Keep
            </Button>
          </>
        ) : (
          <Button variant="quiet" aria-label={`Remove ${s.name}`} onClick={() => setConfirm(true)}>
            <Trash2 className="size-4" aria-hidden />
          </Button>
        )}
      </div>
    </li>
  );
}

function RunRow({ run: r }: { run: SyncRun }) {
  const s = r.summary;
  const detail = r.ok
    ? r.direction === 'mirror'
      ? `Copied ${s.copied ?? 0} tools`
      : `${s.created ?? 0} added, ${s.updated ?? 0} updated, ${s.unchanged ?? 0} unchanged${s.skipped ? `, ${s.skipped} skipped` : ''}`
    : s.message;
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <SourceIcon kind={r.kind} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          {r.direction === 'import' ? 'Import from' : 'Copy to'} {r.sourceLabel}
        </div>
        <div className={`text-sm ${r.ok ? 'text-muted' : 'text-signal'}`}>{detail}</div>
      </div>
      <div className="shrink-0 text-right text-sm text-muted">
        <div>{relative(r.at)}</div>
        <div>{r.trigger === 'schedule' ? 'Scheduled' : r.runByName}</div>
      </div>
    </li>
  );
}
