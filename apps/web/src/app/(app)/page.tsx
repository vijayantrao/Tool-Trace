'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ToolSlot, AssetTag } from '@/components/tool-visuals';
import { ErrorNote, LinkButton, PageHeader, Spinner } from '@/components/ui';
import { errorText } from '@/lib/api';
import { relative } from '@/lib/format';
import { useDashboard, useTools } from '@/lib/queries';
import { can, useMe } from '@/lib/session';
import type { Tool } from '@/lib/types';

type Filter = 'all' | 'in' | 'out' | 'attention';

const needsAttention = (t: Tool) =>
  t.overdue || t.status === 'quarantined' || t.calibrationState === 'expired' || t.calibrationState === 'due_soon';

const filters: { id: Filter; label: string; test: (t: Tool) => boolean }[] = [
  { id: 'all', label: 'All tools', test: () => true },
  { id: 'in', label: 'In the crib', test: (t) => t.status === 'available' },
  { id: 'out', label: 'Out', test: (t) => t.status === 'checked_out' },
  { id: 'attention', label: 'Needs attention', test: needsAttention },
];

function summary(tools: Tool[]): string {
  const out = tools.filter((t) => t.status === 'checked_out').length;
  const overdue = tools.filter((t) => t.overdue).length;
  const locked = tools.filter((t) => t.calibrationState === 'expired').length;
  const parts = [`${out} of ${tools.length} ${tools.length === 1 ? 'tool is' : 'tools are'} out`];
  if (overdue) parts.push(`${overdue} overdue`);
  if (locked) parts.push(`${locked} locked for calibration`);
  return parts.length === 1 ? `${parts[0]}.` : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}.`;
}

export default function BoardPage() {
  const { data: me } = useMe();
  const tools = useTools();
  const dash = useDashboard();
  const [filter, setFilter] = useState<Filter>('all');

  const active = useMemo(() => (tools.data ?? []).filter((t) => t.status !== 'retired'), [tools.data]);
  const shown = active.filter(filters.find((f) => f.id === filter)!.test);
  const byCategory = useMemo(() => {
    const m = new Map<string, Tool[]>();
    for (const t of shown) m.set(t.category, [...(m.get(t.category) ?? []), t]);
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [shown]);

  if (tools.isLoading) return <Spinner label="Loading the board" />;
  if (tools.isError) return <ErrorNote>{errorText(tools.error)}</ErrorNote>;

  const mine = dash.data?.myCheckouts ?? [];

  return (
    <>
      <PageHeader
        title="Tool board"
        sub={active.length ? summary(active) : undefined}
        actions={
          can.manageTools(me?.role) ? (
            <LinkButton href="/tools?add=1" variant="quiet">
              Add a tool
            </LinkButton>
          ) : undefined
        }
      />

      {mine.length > 0 && (
        <section aria-labelledby="mine" className="mb-8">
          <h2 id="mine" className="mb-3 text-xl font-semibold">
            You have {mine.length} {mine.length === 1 ? 'tool' : 'tools'} out
          </h2>
          <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
            {mine.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/tools/${c.toolId}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-board"
                >
                  <AssetTag tag={c.assetTag} />
                  <span className="min-w-0 flex-1 truncate">{c.toolName}</span>
                  <span className={`w-full text-sm sm:w-auto sm:shrink-0 ${c.overdue ? 'font-semibold text-signal' : 'text-muted'}`}>
                    {c.overdue ? 'Overdue, was due ' : 'Due back '}
                    {relative(c.dueBackAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {active.length === 0 ? (
        <div className="pegboard rounded-xl border border-line px-6 py-16 text-center">
          <p className="text-lg">The board is empty.</p>
          <p className="mt-1 text-muted">
            {can.manageTools(me?.role) ? 'Add your first tool to give it a place here.' : 'Your storekeeper hasn’t added any tools yet.'}
          </p>
          {can.manageTools(me?.role) && (
            <LinkButton href="/tools?add=1" className="mt-6">
              Add a tool
            </LinkButton>
          )}
        </div>
      ) : (
        <>
          <div role="radiogroup" aria-label="Show" className="mb-4 flex flex-wrap gap-2">
            {filters.map((f) => {
              const n = active.filter(f.test).length;
              const on = filter === f.id;
              return (
                <button
                  key={f.id}
                  role="radio"
                  aria-checked={on}
                  onClick={() => setFilter(f.id)}
                  className={`min-h-10 rounded-full px-4 text-sm font-semibold transition-colors ${
                    on ? 'bg-ink text-panel' : 'bg-panel text-ink ring-1 ring-inset ring-line hover:ring-ink/40'
                  } ${f.id === 'attention' && n > 0 && !on ? 'text-signal' : ''}`}
                >
                  {f.label} <span className="ml-1 tabular-nums opacity-70">{n}</span>
                </button>
              );
            })}
          </div>

          <div className="pegboard rounded-2xl border border-line p-4 md:p-6">
            {byCategory.length === 0 ? (
              <p className="py-10 text-center text-muted">Nothing here right now.</p>
            ) : (
              byCategory.map(([category, list]) => (
                <section key={category} aria-label={category} className="mb-6 last:mb-0">
                  <h2 className="mb-3 inline-block rounded bg-board/90 pr-2 text-lg font-semibold text-muted">
                    {category}
                  </h2>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                    {list.map((t) => (
                      <ToolSlot key={t.id} tool={t} />
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>
        </>
      )}
    </>
  );
}
