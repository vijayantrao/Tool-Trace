'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ClipboardList } from 'lucide-react';
import { Suspense, useState } from 'react';
import { kindLabel, reasonLabel, RequestForm } from '@/components/request-form';
import { toast } from '@/components/toast';
import { Button, Dialog, ErrorNote, Input, PageHeader, Panel, Spinner } from '@/components/ui';
import { errorText } from '@/lib/api';
import { formatDateTime, relative } from '@/lib/format';
import { useMoney } from '@/lib/meta';
import { useRequest, useRequestAction, useRequests } from '@/lib/queries';
import { can, useMe } from '@/lib/session';
import type { Me, RequestRow, RequestStatus } from '@/lib/types';

type Scope = 'mine' | 'review' | 'approve' | 'all';

const requestNo = (n: number) => `REQ-${String(n).padStart(4, '0')}`;

const statusStyle: Record<RequestStatus, [string, string]> = {
  submitted: ['Waiting for review', 'bg-due-soft text-ink'],
  reviewed: ['Waiting for approval', 'bg-due-soft text-ink ring-1 ring-inset ring-safety'],
  approved: ['Approved', 'bg-ok-soft text-ink'],
  rejected: ['Not approved', 'bg-signal-soft text-ink'],
  fulfilled: ['Fulfilled', 'bg-board text-muted'],
  cancelled: ['Withdrawn', 'bg-board text-muted'],
};

function StatusBadge({ status }: { status: RequestStatus }) {
  const [label, style] = statusStyle[status];
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${style}`}>{label}</span>;
}

function RequestsPage() {
  const { data: me } = useMe();
  const params = useSearchParams();
  const router = useRouter();
  const tabs: { id: Scope; label: string; show: boolean }[] = [
    { id: 'mine', label: 'My requests', show: can.makeRequests(me?.role) },
    { id: 'review', label: 'To review', show: can.reviewRequests(me?.role) },
    { id: 'approve', label: 'To approve', show: can.approveRequests(me?.role) },
    { id: 'all', label: 'All', show: can.seeAllRequests(me?.role) },
  ];
  const visible = tabs.filter((t) => t.show);
  const [scope, setScope] = useState<Scope>(me?.role === 'admin' ? 'approve' : me?.role === 'storekeeper' ? 'review' : me?.role === 'auditor' ? 'all' : 'mine');
  const list = useRequests(scope);
  const money = useMoney();
  const openId = params.get('id');
  const creating = params.get('new') === '1' && can.makeRequests(me?.role);
  const counts = list.data?.counts;

  return (
    <>
      <PageHeader
        title="Requests"
        sub="New tools, replacements and stock: reviewed by a storekeeper, approved by an admin."
        actions={can.makeRequests(me?.role) && <Button onClick={() => router.replace('/requests?new=1')}>New request</Button>}
      />

      <div role="tablist" aria-label="Requests" className="mb-4 flex gap-1 overflow-x-auto rounded-lg bg-panel p-1 ring-1 ring-inset ring-line sm:inline-flex">
        {visible.map((t) => {
          const n = t.id === 'review' ? counts?.toReview : t.id === 'approve' ? counts?.toApprove : undefined;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={scope === t.id}
              onClick={() => setScope(t.id)}
              className={`min-h-10 shrink-0 rounded-md px-4 text-sm font-semibold ${scope === t.id ? 'bg-ink text-panel' : 'text-muted hover:text-ink'}`}
            >
              {t.label}
              {n ? <span className="ml-1.5 rounded-full bg-safety px-1.5 text-xs text-safety-ink">{n}</span> : null}
            </button>
          );
        })}
      </div>

      {list.isLoading ? (
        <Spinner />
      ) : list.isError ? (
        <ErrorNote>{errorText(list.error)}</ErrorNote>
      ) : list.data!.requests.length === 0 ? (
        <Panel className="flex flex-col items-center gap-2 px-6 py-14 text-center">
          <ClipboardList className="size-8 text-muted" aria-hidden />
          <p className="text-lg">
            {scope === 'review' ? 'Nothing to review.' : scope === 'approve' ? 'Nothing waiting for your approval.' : 'No requests yet.'}
          </p>
          {scope === 'mine' && <p className="text-muted">Need a new tool, a replacement or more PPE? Ask here.</p>}
        </Panel>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
          {list.data!.requests.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => router.replace(`/requests?id=${r.id}`)}
                className="flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-board sm:flex-row sm:items-center sm:gap-4"
              >
                <span className="min-w-0 flex-1">
                  <span className="text-sm font-semibold text-muted">{requestNo(r.number)}</span>{' '}
                  <span className="font-semibold">
                    {r.quantity > 1 ? `${r.quantity} × ` : ''}
                    {r.title}
                  </span>
                  <span className="block text-sm text-muted">
                    {kindLabel[r.kind]}: {reasonLabel[r.reason]}
                    {r.toolAssetTag ? ` (${r.toolAssetTag})` : ''} · {r.requestedByName}, {relative(r.createdAt)}
                  </span>
                </span>
                {r.estimatedCost !== null && <span className="text-sm tabular-nums text-muted">{money(r.estimatedCost)}</span>}
                <StatusBadge status={r.status} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={Boolean(openId)} onClose={() => router.replace('/requests')} title={openId ? 'Request' : ''}>
        {openId && me && <RequestDetail id={openId} me={me} />}
      </Dialog>
      <Dialog open={creating} onClose={() => router.replace('/requests')} title="New request">
        <RequestForm onDone={() => router.replace('/requests')} />
      </Dialog>
    </>
  );
}

const actionText: Record<string, string> = {
  submitted: 'asked for it',
  reviewed: 'reviewed it and passed it on for approval',
  approved: 'approved it',
  rejected: 'turned it down',
  fulfilled: 'fulfilled it',
  cancelled: 'withdrew it',
};

function RequestDetail({ id, me }: { id: string; me: Me }) {
  const { data, isLoading, isError, error } = useRequest(id);
  const act = useRequestAction();
  const money = useMoney();
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  if (isLoading) return <Spinner />;
  if (isError || !data) return <ErrorNote>{errorText(error)}</ErrorNote>;
  const r: RequestRow = data.request;

  const mine = r.requestedBy === me.id;
  const canReview = r.status === 'submitted' && can.reviewRequests(me.role) && !mine;
  const canDecide = r.status === 'reviewed' && can.approveRequests(me.role) && !mine && r.reviewedBy !== me.id;
  const canFulfil = r.status === 'approved' && can.reviewRequests(me.role);
  const canWithdraw = mine && (r.status === 'submitted' || r.status === 'reviewed');
  const waitingOnOther =
    r.status === 'reviewed' && can.approveRequests(me.role) && !canDecide
      ? mine
        ? 'Another admin has to approve your own request.'
        : 'You reviewed this one, so another admin has to approve it.'
      : null;

  const run = async (step: 'review' | 'decide' | 'fulfil' | 'cancel', action: string | undefined, done: string) => {
    setErr('');
    try {
      await act.mutateAsync({ id: r.id, step, action, note: note.trim() || undefined });
      toast(done);
      setNote('');
    } catch (e) {
      setErr(errorText(e));
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-muted">{requestNo(r.number)}</span>
          <StatusBadge status={r.status} />
        </div>
        <h3 className="mt-1 text-xl font-semibold">
          {r.quantity > 1 ? `${r.quantity} × ` : ''}
          {r.title}
        </h3>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">Type</dt>
          <dd>
            {kindLabel[r.kind]}: {reasonLabel[r.reason]}
          </dd>
          {r.toolAssetTag && (
            <>
              <dt className="text-muted">Tool</dt>
              <dd>
                <Link href={`/tools/${r.toolId}`} className="font-semibold underline">
                  {r.toolAssetTag} {r.toolName}
                </Link>
              </dd>
            </>
          )}
          {r.stockCode && (
            <>
              <dt className="text-muted">Stock item</dt>
              <dd>
                <Link href={`/stock?item=${r.stockItemId}`} className="font-semibold underline">
                  {r.stockCode} {r.stockName}
                </Link>
              </dd>
            </>
          )}
          {r.estimatedCost !== null && (
            <>
              <dt className="text-muted">Estimated cost</dt>
              <dd className="tabular-nums">{money(r.estimatedCost)}</dd>
            </>
          )}
          <dt className="text-muted">Asked by</dt>
          <dd>{r.requestedByName}</dd>
        </dl>
        {r.details && <p className="mt-3 rounded-md bg-board p-3 text-sm">{r.details}</p>}
      </div>

      <ol className="flex flex-col gap-3 border-l-2 border-line pl-4">
        {data.events.map((e) => (
          <li key={e.id} className="relative text-sm">
            <span className="absolute -left-[1.4rem] top-1.5 size-2.5 rounded-full bg-machine" aria-hidden />
            <span className="font-semibold">{e.byName}</span> {actionText[e.action]}
            <span className="text-muted"> · {formatDateTime(e.at)}</span>
            {e.note && e.action !== 'submitted' && <p className="mt-0.5 text-muted">“{e.note}”</p>}
          </li>
        ))}
      </ol>

      {waitingOnOther && <p className="text-sm text-muted">{waitingOnOther}</p>}

      {(canReview || canDecide || canFulfil || canWithdraw) && (
        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <Input aria-label="Note (optional)" placeholder="Note (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          <ErrorNote>{err}</ErrorNote>
          <div className="flex flex-wrap gap-2">
            {canReview && (
              <>
                <Button busy={act.isPending} onClick={() => run('review', 'forward', 'Passed on for approval')}>
                  Pass on for approval
                </Button>
                <Button variant="quiet" onClick={() => run('review', 'reject', 'Request turned down')}>
                  Turn down
                </Button>
              </>
            )}
            {canDecide && (
              <>
                <Button busy={act.isPending} onClick={() => run('decide', 'approve', 'Approved')}>
                  Approve
                </Button>
                <Button variant="quiet" onClick={() => run('decide', 'reject', 'Request turned down')}>
                  Turn down
                </Button>
              </>
            )}
            {canFulfil && (
              <Button busy={act.isPending} onClick={() => run('fulfil', undefined, 'Marked fulfilled')}>
                Mark fulfilled
              </Button>
            )}
            {canWithdraw && (
              <Button variant="quiet" onClick={() => run('cancel', undefined, 'Request withdrawn')}>
                Withdraw request
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Spinner />}>
      <RequestsPage />
    </Suspense>
  );
}
