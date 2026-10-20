'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Briefcase, QrCode, X } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { AckLine } from '@/components/ack';
import { DuePicker } from '@/components/due-picker';
import { KitStateBadge } from '@/components/kit-state';
import { toast } from '@/components/toast';
import { AssetTag, StatusTag } from '@/components/tool-visuals';
import { Button, ErrorNote, Field, Input, Panel, Select, Spinner } from '@/components/ui';
import { errorText } from '@/lib/api';
import { formatDateTime, relative } from '@/lib/format';
import { useAddKitTool, useHolders, useKit, useKitCheckout, useKitReturn, useRemoveKitTool, useUpdateKit } from '@/lib/queries';
import { can, useMe } from '@/lib/session';
import type { KitDetail, Me } from '@/lib/types';

export default function KitPage() {
  const { id } = useParams<{ id: string }>();
  const { data: me } = useMe();
  const { data: kit, isLoading, isError, error } = useKit(id);

  if (isLoading) return <Spinner />;
  if (isError || !kit || !me) return <ErrorNote>{errorText(error)}</ErrorNote>;
  const staff = can.manageTools(me.role);
  const outPieces = kit.tools.filter((t) => t.kitIssueId);

  return (
    <div className="max-w-3xl">
      <Link href="/kits" className="mb-5 inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> Kits
      </Link>
      <header className="mb-6 flex items-start gap-4">
        <div className="hidden size-20 shrink-0 place-items-center rounded-xl border-2 border-ink/15 bg-panel sm:grid">
          <Briefcase className="size-11" strokeWidth={1.6} aria-hidden />
        </div>
        <div className="min-w-0">
          <AssetTag tag={kit.assetTag} size="lg" />
          <h1 className="mt-2 text-[1.9rem] font-semibold md:text-[2.3rem]">{kit.name}</h1>
          <p className="text-muted">
            {kit.tools.length} {kit.tools.length === 1 ? 'tool' : 'tools'}, kept at {kit.homeLocationName}
          </p>
          <div className="mt-3">
            <KitStateBadge state={kit.state} />
          </div>
        </div>
      </header>

      <div className="flex flex-col gap-5">
        {kit.openIssue && (
          <Panel className={`p-5 ${kit.openIssue.overdue ? 'border-signal' : ''}`}>
            <h2 className="text-2xl font-semibold">{kit.openIssue.holderId === me.id ? 'You have this kit' : `With ${kit.openIssue.holderName}`}</h2>
            <p className="mt-1 text-muted">
              Issued {formatDateTime(kit.openIssue.issuedAt)} by {kit.openIssue.issuedByName}.{' '}
              <span className={kit.openIssue.overdue ? 'font-semibold text-signal' : ''}>
                {kit.openIssue.overdue ? 'Overdue: was due ' : 'Due back '}
                {relative(kit.openIssue.dueBackAt)}.
              </span>
            </p>
            {kit.openIssue.ackStatus && (
              <div className="mt-3">
                <AckLine status={kit.openIssue.ackStatus} who={kit.openIssue.holderId === me.id ? 'you' : kit.openIssue.holderName} />
              </div>
            )}
            {staff && outPieces.length > 0 && <ReturnChecklist kit={kit} />}
          </Panel>
        )}

        {kit.state === 'in_crib' && kit.isActive && can.checkOut(me.role) && <KitCheckout kit={kit} me={me} />}

        <Panel className="p-5">
          <h2 className="text-2xl font-semibold">In this kit</h2>
          {kit.tools.length === 0 ? (
            <p className="mt-2 text-muted">No tools yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line border-t border-line">
              {kit.tools.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
                  <Link href={`/tools/${t.id}`} className="flex min-w-0 flex-1 items-center gap-3 hover:underline">
                    <AssetTag tag={t.assetTag} />
                    <span className="truncate">{t.name}</span>
                  </Link>
                  <StatusTag status={t.status} />
                  {t.calibrationExpired && t.status === 'available' && <span className="text-sm font-semibold text-signal">Calibration expired</span>}
                  {t.holderName && !t.kitIssueId && <span className="text-sm text-muted">out on its own with {t.holderName}</span>}
                  {staff && !t.checkoutId && <RemoveButton kitId={kit.id} toolId={t.id} tag={t.assetTag} />}
                </li>
              ))}
            </ul>
          )}
          {staff && <AddTool kitId={kit.id} />}
        </Panel>

        {staff && <KitManage kit={kit} />}
      </div>
    </div>
  );
}

function KitCheckout({ kit, me }: { kit: KitDetail; me: Me }) {
  const issue = can.issueToOthers(me.role);
  const holders = useHolders(issue);
  const checkout = useKitCheckout();
  const [hours, setHours] = useState(8);
  const [holderId, setHolderId] = useState(me.id);
  const [error, setError] = useState('');
  const due = useMemo(() => new Date(Date.now() + hours * 3_600_000), [hours]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await checkout.mutateAsync({ id: kit.id, holderId, dueBackAt: due.toISOString() });
      toast(`Kit ${kit.assetTag} checked out (${kit.tools.length} tools)`);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Panel className="p-5">
      <h2 className="text-2xl font-semibold">Check out the whole kit</h2>
      <p className="mt-1 text-muted">Every tool in it is checked out together, with the same due time.</p>
      <form onSubmit={submit} className="mt-4 flex flex-col gap-5">
        {issue && (
          <Field label="Issue to" htmlFor="kitHolder">
            <Select id="kitHolder" value={holderId} onChange={(e) => setHolderId(e.target.value)}>
              <option value={me.id}>Me ({me.displayName})</option>
              {holders.data
                ?.filter((h) => h.id !== me.id)
                .map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.displayName}
                  </option>
                ))}
            </Select>
          </Field>
        )}
        <DuePicker hours={hours} onChange={setHours} due={due} />
        <ErrorNote>{error}</ErrorNote>
        <Button type="submit" busy={checkout.isPending} className="sm:self-start">
          Check out {kit.assetTag}
        </Button>
      </form>
    </Panel>
  );
}

type Condition = 'ok' | 'damaged' | 'needs_calibration' | 'missing';
const conditions: { value: Condition; label: string }[] = [
  { value: 'ok', label: 'Good' },
  { value: 'damaged', label: 'Damaged' },
  { value: 'needs_calibration', label: 'Needs cal' },
  { value: 'missing', label: 'Missing' },
];

/** Every piece still out gets a tick: back in some condition, or missing. */
function ReturnChecklist({ kit }: { kit: KitDetail }) {
  const ret = useKitReturn();
  const pieces = kit.tools.filter((t) => t.kitIssueId);
  const [state, setState] = useState<Record<string, Condition | undefined>>({});
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const done = pieces.every((p) => state[p.id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const r = await ret.mutateAsync({
        id: kit.id,
        tools: pieces.map((p) => ({ toolId: p.id, condition: state[p.id]! })),
        notes: notes.trim() || undefined,
      });
      toast(r.missing.length ? `${r.returned} back; still out: ${r.missing.join(', ')}` : `Kit ${kit.assetTag} is back`, r.missing.length ? 'info' : 'ok');
      setState({});
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <form onSubmit={submit} className="mt-5 flex flex-col gap-4 border-t border-line pt-5">
      <fieldset>
        <legend className="mb-2 font-semibold">Receive it back: tick off every piece</legend>
        <ul className="flex flex-col gap-2">
          {pieces.map((p) => (
            <li key={p.id} className="flex flex-col gap-2 rounded-md p-2 ring-1 ring-inset ring-line sm:flex-row sm:items-center">
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <AssetTag tag={p.assetTag} />
                <span className="truncate text-sm">{p.name}</span>
              </span>
              <span role="radiogroup" aria-label={`${p.assetTag} condition`} className="grid grid-cols-4 gap-1">
                {conditions.map((c) => (
                  <button
                    type="button"
                    key={c.value}
                    role="radio"
                    aria-checked={state[p.id] === c.value}
                    onClick={() => setState((s) => ({ ...s, [p.id]: c.value }))}
                    className={`min-h-9 rounded px-2 text-xs font-semibold ${
                      state[p.id] === c.value
                        ? c.value === 'missing'
                          ? 'bg-signal text-white'
                          : 'bg-ink text-panel'
                        : 'ring-1 ring-inset ring-line hover:ring-ink/40'
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </fieldset>
      <Input aria-label="Notes (optional)" placeholder="Notes (optional)" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
      <ErrorNote>{error}</ErrorNote>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={ret.isPending} disabled={!done}>
          Receive {kit.assetTag}
        </Button>
        <Button type="button" variant="quiet" onClick={() => setState(Object.fromEntries(pieces.map((p) => [p.id, 'ok' as const])))}>
          All back, good
        </Button>
      </div>
    </form>
  );
}

function AddTool({ kitId }: { kitId: string }) {
  const add = useAddKitTool();
  const [tag, setTag] = useState('');
  const [error, setError] = useState('');
  return (
    <form
      className="mt-4 flex flex-col gap-2 sm:flex-row"
      onSubmit={async (e) => {
        e.preventDefault();
        setError('');
        try {
          await add.mutateAsync({ id: kitId, assetTag: tag.trim().toUpperCase() });
          toast(`${tag.trim().toUpperCase()} added to the kit`);
          setTag('');
        } catch (err) {
          setError(errorText(err));
        }
      }}
    >
      <Input aria-label="Add a tool by asset tag" placeholder="Add a tool by asset tag" value={tag} onChange={(e) => setTag(e.target.value)} className="uppercase sm:flex-1" required />
      <Button type="submit" variant="quiet" busy={add.isPending}>
        Add to kit
      </Button>
      {error && <p className="text-sm text-signal sm:basis-full">{error}</p>}
    </form>
  );
}

function RemoveButton({ kitId, toolId, tag }: { kitId: string; toolId: string; tag: string }) {
  const remove = useRemoveKitTool();
  return (
    <button
      type="button"
      aria-label={`Take ${tag} out of the kit`}
      title="Take out of the kit"
      onClick={async () => {
        try {
          await remove.mutateAsync({ id: kitId, toolId });
          toast(`${tag} taken out of the kit`);
        } catch (err) {
          toast(errorText(err), 'error');
        }
      }}
      className="grid size-9 place-items-center rounded-md text-muted hover:bg-board hover:text-ink"
    >
      <X className="size-4" aria-hidden />
    </button>
  );
}

function KitManage({ kit }: { kit: KitDetail }) {
  const update = useUpdateKit();
  return (
    <div className="flex flex-wrap gap-2 border-t border-line pt-5">
      <Link href={`/labels?kits=${kit.id}`} className="inline-flex min-h-11 items-center gap-2 rounded-md px-4 font-semibold ring-1 ring-inset ring-line hover:bg-panel">
        <QrCode className="size-4" aria-hidden /> Print QR label
      </Link>
      {kit.state !== 'out' && kit.state !== 'partial' && (
        <Button
          variant="quiet"
          busy={update.isPending}
          onClick={async () => {
            try {
              await update.mutateAsync({ id: kit.id, isActive: !kit.isActive });
              toast(kit.isActive ? `${kit.assetTag} is no longer in use` : `${kit.assetTag} is in use again`);
            } catch (err) {
              toast(errorText(err), 'error');
            }
          }}
        >
          {kit.isActive ? 'Stop using this kit' : 'Use this kit again'}
        </Button>
      )}
    </div>
  );
}
