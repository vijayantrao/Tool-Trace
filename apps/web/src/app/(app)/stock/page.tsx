'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { PackageOpen, Search } from 'lucide-react';
import { Suspense, useDeferredValue, useState, type FormEvent } from 'react';
import { AckButtons, AckLine } from '@/components/ack';
import { ClassBadge } from '@/components/price-tag';
import { toast } from '@/components/toast';
import { Button, Dialog, ErrorNote, Field, Input, PageHeader, Panel, Select, Spinner } from '@/components/ui';
import { errorText } from '@/lib/api';
import { formatDateTime, relative } from '@/lib/format';
import { useMoney } from '@/lib/meta';
import {
  useCreateStockItem,
  useHolders,
  useLocations,
  useMyStock,
  useStock,
  useStockItem,
  useStockMovement,
  useUpdateStockItem,
  type MovementBody,
} from '@/lib/queries';
import { can, useMe } from '@/lib/session';
import type { StockItem, StockKind, StockMovement } from '@/lib/types';

const kinds: { id: '' | StockKind; label: string }[] = [
  { id: '', label: 'Everything' },
  { id: 'ppe', label: 'PPE' },
  { id: 'consumable', label: 'Consumables' },
];

function StockPage() {
  const { data: me } = useMe();
  const params = useSearchParams();
  const router = useRouter();
  const [kind, setKind] = useState<'' | StockKind>('');
  const [low, setLow] = useState(false);
  const [q, setQ] = useState('');
  const query = useDeferredValue({ kind, q: q.trim(), low: low ? 'true' : '' });
  const items = useStock(query);
  const money = useMoney();
  const staff = can.manageStock(me?.role);
  const openId = params.get('item');
  const adding = params.get('add') === '1' && staff;

  return (
    <>
      <PageHeader
        title="PPE & stock"
        sub="Gloves, goggles, cable ties: counted in quantities, issued to people, reordered in time."
        actions={staff && <Button onClick={() => router.replace('/stock?add=1')}>Add an item</Button>}
      />

      {me?.role !== 'auditor' && <MyIssues />}

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
        <div role="tablist" aria-label="Kind" className="flex gap-1 rounded-lg bg-panel p-1 ring-1 ring-inset ring-line">
          {kinds.map((k) => (
            <button
              key={k.id}
              role="tab"
              aria-selected={kind === k.id}
              onClick={() => setKind(k.id)}
              className={`min-h-10 flex-1 rounded-md px-4 text-sm font-semibold lg:flex-none ${kind === k.id ? 'bg-ink text-panel' : 'text-muted hover:text-ink'}`}
            >
              {k.label}
            </button>
          ))}
        </div>
        <label className="flex min-h-11 items-center gap-2 rounded-md px-3 ring-1 ring-inset ring-line">
          <input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} className="size-4 accent-[var(--signal)]" />
          <span className="text-sm font-semibold">Reorder now</span>
        </label>
        <label className="relative flex-1">
          <span className="sr-only">Search stock</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by code, name or category" className="pl-9" type="search" />
        </label>
      </div>

      {items.isLoading ? (
        <Spinner />
      ) : items.isError ? (
        <ErrorNote>{errorText(items.error)}</ErrorNote>
      ) : items.data!.length === 0 ? (
        <Panel className="flex flex-col items-center gap-2 px-6 py-14 text-center">
          <PackageOpen className="size-8 text-muted" aria-hidden />
          <p className="text-lg">{low ? 'Nothing needs reordering.' : 'No items yet.'}</p>
          {staff && !low && <p className="text-muted">Add the PPE and consumables the crib keeps, with how many are on the shelf.</p>}
        </Panel>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-panel">
          <table className="w-full text-left">
            <thead className="hidden border-b border-line text-sm text-muted md:table-header-group">
              <tr>
                <th className="px-4 py-3 font-semibold">Item</th>
                <th className="px-4 py-3 font-semibold">In stock</th>
                <th className="px-4 py-3 font-semibold">Kept at</th>
                <th className="px-4 py-3 text-right font-semibold">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.data!.map((i) => (
                <tr key={i.id} className="relative block hover:bg-board md:table-row">
                  <td className="block px-4 pt-3 md:table-cell md:py-3">
                    <button onClick={() => router.replace(`/stock?item=${i.id}`)} className="flex items-center gap-3 text-left after:absolute after:inset-0">
                      <span className="tag-plate rounded-[4px] border border-line px-1.5 py-0.5 text-[0.85rem]">{i.code}</span>
                      <span className="min-w-0">
                        <span className="block font-medium">{i.name}</span>
                        <span className="block text-sm text-muted">
                          {i.kind === 'ppe' ? 'PPE' : 'Consumable'}, {i.category}
                        </span>
                      </span>
                    </button>
                  </td>
                  <td className="block px-4 pt-2 md:table-cell md:py-3">
                    <span className={`text-lg font-semibold tabular-nums ${i.low ? 'text-signal' : ''}`}>{i.quantity}</span>{' '}
                    <span className="text-sm text-muted">{i.unit}</span>
                    {i.low && <span className="ml-2 rounded bg-signal px-1.5 py-0.5 text-xs font-bold text-white">Reorder</span>}
                    {i.reorderLevel > 0 && <span className="block text-xs text-muted">Reorder at {i.reorderLevel}</span>}
                  </td>
                  <td className="block px-4 pt-1 text-sm text-muted md:table-cell md:py-3">{i.locationName}</td>
                  <td className="block px-4 pb-3 text-sm md:table-cell md:py-3 md:text-right">
                    {i.stockValue !== null && (
                      <span className="inline-flex items-center gap-1.5 tabular-nums">
                        {money(i.stockValue)} <ClassBadge abcClass={i.abcClass} />
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={Boolean(openId)} onClose={() => router.replace('/stock')} title="Stock item">
        {openId && <ItemDetail id={openId} staff={staff} />}
      </Dialog>
      <Dialog open={adding} onClose={() => router.replace('/stock')} title="Add an item">
        <AddItemForm onDone={(id) => router.replace(`/stock?item=${id}`)} />
      </Dialog>
    </>
  );
}

function MyIssues() {
  const mine = useMyStock();
  const pending = (mine.data ?? []).filter((m) => m.ackStatus === 'pending');
  const recent = (mine.data ?? []).slice(0, 5);
  if (!mine.data?.length) return null;
  return (
    <section aria-labelledby="issued-to-me" className="mb-8">
      <h2 id="issued-to-me" className="mb-3 text-xl font-semibold">
        Issued to you
      </h2>
      <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
        {(pending.length ? pending : recent).map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">
                {m.quantity} {m.unit} {m.name}
              </span>
              <span className="text-sm text-muted">
                {m.code}, from {m.byName} {relative(m.at)}
              </span>
            </span>
            {m.ackStatus === 'pending' && m.ackId ? <AckButtons id={m.ackId} compact /> : m.ackStatus && <AckLine status={m.ackStatus} who="you" />}
          </li>
        ))}
      </ul>
    </section>
  );
}

const movementText = (m: StockMovement, unit: string) => {
  const n = Math.abs(m.quantity);
  switch (m.kind) {
    case 'receive':
      return `Received ${n} ${unit}`;
    case 'issue':
      return `Issued ${n} ${unit} to ${m.issuedToName}`;
    case 'return':
      return `${m.issuedToName} returned ${n} ${unit}`;
    default:
      return `Count corrected by ${m.quantity > 0 ? '+' : ''}${m.quantity} ${unit}`;
  }
};

function ItemDetail({ id, staff }: { id: string; staff: boolean }) {
  const { data, isLoading, isError, error } = useStockItem(id);
  const money = useMoney();
  const update = useUpdateStockItem();
  if (isLoading) return <Spinner />;
  if (isError || !data) return <ErrorNote>{errorText(error)}</ErrorNote>;
  const { item, movements } = data;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <span className="tag-plate rounded-[4px] border border-line px-1.5 py-0.5">{item.code}</span>
        <h3 className="mt-2 text-xl font-semibold">{item.name}</h3>
        <p className="text-sm text-muted">
          {item.kind === 'ppe' ? 'PPE' : 'Consumable'}, {item.category}, kept at {item.locationName}
          {item.unitPrice !== null && `, ${money(item.unitPrice)} per ${item.unit.replace(/s$/, '')}`}
        </p>
        <p className="mt-3 text-3xl font-semibold tabular-nums">
          <span className={item.low ? 'text-signal' : ''}>{item.quantity}</span> <span className="text-base font-normal text-muted">{item.unit} in stock</span>
        </p>
        {item.low && <p className="font-semibold text-signal">At or below its reorder level ({item.reorderLevel}).</p>}
        {!item.isActive && <p className="font-semibold text-muted">No longer stocked.</p>}
      </div>

      {staff && item.isActive && <MovementForm item={item} />}

      <section>
        <h4 className="mb-2 font-semibold">History</h4>
        {movements.length === 0 ? (
          <p className="text-sm text-muted">Nothing yet.</p>
        ) : (
          <ol className="max-h-72 divide-y divide-line overflow-y-auto rounded-md border border-line">
            {movements.map((m) => (
              <li key={m.id} className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
                <span>
                  <span className="font-medium">{movementText(m, item.unit)}</span>
                  {m.note && <span className="text-muted">: {m.note}</span>}
                  {m.ackStatus === 'pending' && <span className="ml-1 text-xs text-muted">(not confirmed yet)</span>}
                  {m.ackStatus === 'disputed' && <span className="ml-1 text-xs font-semibold text-signal">(says not received)</span>}
                </span>
                <span className="text-muted">
                  {formatDateTime(m.at)} · {m.byName} · left {m.balanceAfter}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {staff && (
        <div className="flex flex-wrap gap-2 border-t border-line pt-4">
          <Button
            variant="quiet"
            busy={update.isPending}
            onClick={async () => {
              try {
                await update.mutateAsync({ id: item.id, isActive: !item.isActive });
                toast(item.isActive ? `${item.code} is no longer stocked` : `${item.code} is stocked again`);
              } catch (err) {
                toast(errorText(err), 'error');
              }
            }}
          >
            {item.isActive ? 'Stop stocking this' : 'Stock it again'}
          </Button>
        </div>
      )}
    </div>
  );
}

const actions = [
  { id: 'issue', label: 'Issue' },
  { id: 'receive', label: 'Receive' },
  { id: 'return', label: 'Return' },
  { id: 'adjust', label: 'Count' },
] as const;

function MovementForm({ item }: { item: StockItem }) {
  const move = useStockMovement();
  const holders = useHolders(true);
  const [kind, setKind] = useState<(typeof actions)[number]['id']>('issue');
  const [error, setError] = useState('');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const form = e.currentTarget;
    const f = new FormData(form);
    const note = String(f.get('note') ?? '').trim();
    const n = Number(f.get('quantity'));
    let body: MovementBody;
    if (kind === 'adjust') body = { kind, countedQuantity: n, note };
    else if (kind === 'receive') body = { kind, quantity: n, note: note || undefined };
    else body = { kind, quantity: n, issuedTo: String(f.get('person')), note: note || undefined };
    try {
      const r = await move.mutateAsync({ id: item.id, ...body });
      toast(`${item.code}: ${r.movement.balanceAfter} ${item.unit} left`);
      form.reset();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-md bg-board p-4">
      <div role="tablist" aria-label="What happened" className="grid grid-cols-4 gap-1">
        {actions.map((a) => (
          <button
            type="button"
            key={a.id}
            role="tab"
            aria-selected={kind === a.id}
            onClick={() => setKind(a.id)}
            className={`min-h-10 rounded-md text-sm font-semibold ${kind === a.id ? 'bg-ink text-panel' : 'bg-panel ring-1 ring-inset ring-line'}`}
          >
            {a.label}
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {(kind === 'issue' || kind === 'return') && (
          <Field label={kind === 'issue' ? 'Issue to' : 'Returned by'} htmlFor="person">
            <Select id="person" name="person" required defaultValue="">
              <option value="" disabled>
                Choose a person
              </option>
              {holders.data?.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.displayName}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={kind === 'adjust' ? `Counted on the shelf (${item.unit})` : `Quantity (${item.unit})`} htmlFor="quantity">
          <Input id="quantity" name="quantity" type="number" min={kind === 'adjust' ? 0 : 1} max={1000000} required key={kind} defaultValue={kind === 'adjust' ? item.quantity : 1} />
        </Field>
        <div className={kind === 'issue' || kind === 'return' ? 'sm:col-span-2' : ''}>
          <Field label={kind === 'adjust' ? 'Why it differs' : 'Note (optional)'} htmlFor="note">
            <Input id="note" name="note" maxLength={300} required={kind === 'adjust'} minLength={kind === 'adjust' ? 3 : undefined} placeholder={kind === 'receive' ? 'PO number' : ''} />
          </Field>
        </div>
      </div>
      <ErrorNote>{error}</ErrorNote>
      <Button type="submit" busy={move.isPending} className="sm:self-start">
        {kind === 'issue' ? 'Issue' : kind === 'receive' ? 'Add to stock' : kind === 'return' ? 'Take back' : 'Save count'}
      </Button>
    </form>
  );
}

function AddItemForm({ onDone }: { onDone: (id: string) => void }) {
  const create = useCreateStockItem();
  const locations = useLocations();
  const [error, setError] = useState('');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const f = new FormData(e.currentTarget);
    const t = (k: string) => String(f.get(k) ?? '').trim();
    try {
      const { item } = await create.mutateAsync({
        code: t('code').toUpperCase(),
        name: t('name'),
        kind: t('kind') as StockKind,
        category: t('category'),
        unit: t('unit') || 'pcs',
        locationId: t('locationId'),
        reorderLevel: Number(t('reorderLevel') || 0),
        unitPrice: t('unitPrice') ? Number(t('unitPrice')) : undefined,
        openingQuantity: Number(t('openingQuantity') || 0),
      });
      toast(`Added ${item.code}`);
      onDone(item.id);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <Field label="Code" htmlFor="code" hint="e.g. PPE-GLV-01">
        <Input id="code" name="code" required pattern="[A-Za-z0-9][A-Za-z0-9\-]{2,31}" className="tag-plate uppercase" />
      </Field>
      <Field label="Type" htmlFor="kind">
        <Select id="kind" name="kind" defaultValue="ppe">
          <option value="ppe">PPE</option>
          <option value="consumable">Consumable</option>
        </Select>
      </Field>
      <div className="sm:col-span-2">
        <Field label="Name" htmlFor="itemName">
          <Input id="itemName" name="name" required maxLength={120} placeholder="Cut-resistant gloves" />
        </Field>
      </div>
      <Field label="Category" htmlFor="itemCategory">
        <Input id="itemCategory" name="category" required maxLength={60} placeholder="Hand protection" />
      </Field>
      <Field label="Counted in" htmlFor="unit">
        <Input id="unit" name="unit" maxLength={20} defaultValue="pcs" list="units" />
        <datalist id="units">
          {['pcs', 'pairs', 'boxes', 'm', 'kg', 'litres', 'rolls', 'packs'].map((u) => (
            <option key={u} value={u} />
          ))}
        </datalist>
      </Field>
      <Field label="Kept at" htmlFor="locationId">
        <Select id="locationId" name="locationId" required key={locations.data?.length ?? 0} defaultValue={locations.data?.find((l) => l.kind === 'crib')?.id}>
          {locations.data?.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="On the shelf now" htmlFor="openingQuantity">
        <Input id="openingQuantity" name="openingQuantity" type="number" min={0} defaultValue={0} />
      </Field>
      <Field label="Reorder at" htmlFor="reorderLevel" hint="The crib is told when stock falls to this. 0 = never.">
        <Input id="reorderLevel" name="reorderLevel" type="number" min={0} defaultValue={0} />
      </Field>
      <Field label="Unit price (optional)" htmlFor="itemPrice">
        <Input id="itemPrice" name="unitPrice" type="number" min={0} step="0.01" inputMode="decimal" />
      </Field>
      <div className="flex flex-col gap-3 sm:col-span-2">
        <ErrorNote>{error}</ErrorNote>
        <Button type="submit" busy={create.isPending}>
          Add item
        </Button>
      </div>
    </form>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Spinner />}>
      <StockPage />
    </Suspense>
  );
}
