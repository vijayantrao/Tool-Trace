'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AssetTag } from '@/components/tool-visuals';
import { ErrorNote, PageHeader, Spinner } from '@/components/ui';
import { errorText } from '@/lib/api';
import { formatDateTime, relative } from '@/lib/format';
import { useCheckouts } from '@/lib/queries';
import { useMe } from '@/lib/session';
import type { Checkout } from '@/lib/types';

const views = [
  { id: 'open', label: 'Out now', query: { open: 'true' } },
  { id: 'overdue', label: 'Overdue', query: { overdue: 'true' } },
  { id: 'all', label: 'History', query: {} },
] as const;

const conditionText = { ok: 'Returned in good condition', damaged: 'Returned damaged', needs_calibration: 'Returned, needs calibration' };

export default function CheckoutsPage() {
  const { data: me } = useMe();
  const [view, setView] = useState<(typeof views)[number]['id']>('open');
  const q = useCheckouts({ ...views.find((v) => v.id === view)!.query });

  return (
    <>
      <PageHeader
        title="Checkouts"
        sub={me?.role === 'technician' ? 'Tools you have taken out, and what you have returned.' : 'Who has what, and what came back.'}
      />
      <div role="tablist" aria-label="Checkouts" className="mb-4 flex gap-1 rounded-lg bg-panel p-1 ring-1 ring-inset ring-line sm:inline-flex">
        {views.map((v) => (
          <button
            key={v.id}
            role="tab"
            aria-selected={view === v.id}
            onClick={() => setView(v.id)}
            className={`min-h-10 flex-1 rounded-md px-4 text-sm font-semibold sm:flex-none ${
              view === v.id ? 'bg-ink text-panel' : 'text-muted hover:text-ink'
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <ErrorNote>{errorText(q.error)}</ErrorNote>
      ) : q.data!.length === 0 ? (
        <p className="rounded-lg border border-line bg-panel px-4 py-10 text-center text-muted">
          {view === 'overdue' ? 'Nothing is overdue.' : view === 'open' ? 'No tools are out right now.' : 'No checkouts yet.'}
        </p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
          {q.data!.map((c) => (
            <Row key={c.id} c={c} />
          ))}
        </ul>
      )}
    </>
  );
}

function Row({ c }: { c: Checkout }) {
  return (
    <li>
      <Link href={`/tools/${c.toolId}`} className="flex flex-col gap-1 px-4 py-3 hover:bg-board sm:flex-row sm:items-center sm:gap-4">
        <span className="flex min-w-0 flex-1 items-center gap-3">
          <AssetTag tag={c.assetTag} />
          <span className="truncate">{c.toolName}</span>
        </span>
        <span className="text-sm sm:w-40 sm:shrink-0">{c.holderName}</span>
        <span className={`text-sm sm:w-64 sm:shrink-0 sm:text-right ${c.overdue ? 'font-semibold text-signal' : 'text-muted'}`}>
          {c.returnedAt
            ? `${c.conditionOnReturn ? conditionText[c.conditionOnReturn] : 'Returned'} ${formatDateTime(c.returnedAt)}`
            : `${c.overdue ? 'Overdue, was due' : 'Due back'} ${relative(c.dueBackAt)}`}
        </span>
      </Link>
    </li>
  );
}
