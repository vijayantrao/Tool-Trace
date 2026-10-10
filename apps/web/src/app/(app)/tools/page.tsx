'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search } from 'lucide-react';
import { Suspense, useDeferredValue, useState, type FormEvent } from 'react';
import { AssetTag, CalSticker, StatusTag } from '@/components/tool-visuals';
import { toast } from '@/components/toast';
import { Button, Dialog, ErrorNote, Field, Input, PageHeader, Select, Spinner } from '@/components/ui';
import { errorText } from '@/lib/api';
import { relative, todayIso } from '@/lib/format';
import { useCreateTool, useLocations, useTools } from '@/lib/queries';
import { can, useMe } from '@/lib/session';

function ToolsList() {
  const { data: me } = useMe();
  const params = useSearchParams();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [calibration, setCalibration] = useState(params.get('calibration') ?? '');
  const query = useDeferredValue({ q: q.trim(), status, calibration });
  const tools = useTools(query);
  const adding = params.get('add') === '1' && can.manageTools(me?.role);

  return (
    <>
      <PageHeader
        title="Tools"
        sub="Every tool the crib looks after, where it is and whether it's fit to use."
        actions={
          can.manageTools(me?.role) && (
            <Button onClick={() => router.replace('/tools?add=1')}>Add a tool</Button>
          )
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_12rem_14rem]">
        <label className="relative">
          <span className="sr-only">Search tools</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by asset tag or name"
            className="pl-9"
            type="search"
          />
        </label>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          <option value="available">In the crib</option>
          <option value="checked_out">Checked out</option>
          <option value="quarantined">Quarantined</option>
          <option value="retired">Retired</option>
        </Select>
        <Select value={calibration} onChange={(e) => setCalibration(e.target.value)} aria-label="Calibration">
          <option value="">Any calibration state</option>
          <option value="expired">Calibration expired</option>
          <option value="due_soon">Calibration due soon</option>
          <option value="ok">Calibrated</option>
          <option value="not_required">No calibration needed</option>
        </Select>
      </div>

      {tools.isLoading ? (
        <Spinner />
      ) : tools.isError ? (
        <ErrorNote>{errorText(tools.error)}</ErrorNote>
      ) : tools.data!.length === 0 ? (
        <p className="rounded-lg border border-line bg-panel px-4 py-10 text-center text-muted">
          No tools match. Clear the search or filters to see everything.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-panel">
          <table className="w-full text-left">
            <thead className="hidden border-b border-line text-sm text-muted md:table-header-group">
              <tr>
                <th className="px-4 py-3 font-semibold">Tool</th>
                <th className="px-4 py-3 font-semibold">Where it is</th>
                <th className="px-4 py-3 font-semibold">Calibration</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {tools.data!.map((t) => (
                <tr key={t.id} className="relative block hover:bg-board md:table-row">
                  <td className="block px-4 pt-3 md:table-cell md:py-3">
                    <Link href={`/tools/${t.id}`} className="flex items-center gap-3 after:absolute after:inset-0">
                      <AssetTag tag={t.assetTag} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{t.name}</span>
                        <span className="block text-sm text-muted">{t.category}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="block px-4 pt-2 md:table-cell md:py-3">
                    <StatusTag status={t.status} />
                    <span className={`ml-2 text-sm ${t.overdue ? 'font-semibold text-signal' : 'text-muted'}`}>
                      {t.status === 'checked_out'
                        ? `${t.holderName}, ${t.overdue ? 'overdue' : 'due'} ${t.dueBackAt ? relative(t.dueBackAt) : ''}`
                        : t.homeLocationName}
                    </span>
                  </td>
                  <td className="block px-4 pb-3 pt-2 md:table-cell md:py-3">
                    <CalSticker state={t.calibrationState} dueOn={t.calibrationDueOn} />
                    {t.calibrationState === 'not_required' && <span className="text-sm text-muted">Not needed</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={adding} onClose={() => router.replace('/tools')} title="Add a tool">
        <AddToolForm onDone={(id) => router.replace(`/tools/${id}`)} />
      </Dialog>
    </>
  );
}

function AddToolForm({ onDone }: { onDone: (id: string) => void }) {
  const locations = useLocations();
  const create = useCreateTool();
  const [cal, setCal] = useState(true);
  const [error, setError] = useState('');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const f = new FormData(e.currentTarget);
    try {
      const { tool } = await create.mutateAsync({
        assetTag: String(f.get('assetTag')).trim().toUpperCase(),
        name: String(f.get('name')).trim(),
        category: String(f.get('category')).trim(),
        homeLocationId: String(f.get('homeLocationId')),
        requiresCalibration: cal,
        ...(cal
          ? {
              calibrationIntervalDays: Number(f.get('interval')),
              lastCalibratedOn: String(f.get('lastCalibratedOn')),
            }
          : {}),
      });
      toast(`Added ${tool.assetTag} to the board`);
      onDone(tool.id);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Asset tag" htmlFor="assetTag" hint="As engraved on the tool, e.g. TW-0104">
          <Input
            id="assetTag"
            name="assetTag"
            required
            pattern="[A-Za-z0-9][A-Za-z0-9\-]{2,31}"
            className="tag-plate uppercase"
            autoCapitalize="characters"
          />
        </Field>
        <Field label="Category" htmlFor="category" hint="Tools are grouped by this on the board">
          <Input id="category" name="category" required list="categories" placeholder="Torque" />
          <datalist id="categories">
            {['Torque', 'Measuring', 'Electrical', 'Inspection', 'Power Tools', 'Hand Tools'].map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
      </div>
      <Field label="Name" htmlFor="name">
        <Input id="name" name="name" required maxLength={120} placeholder="Torque wrench 20–100 Nm" />
      </Field>
      <Field label="Home location" htmlFor="homeLocationId">
        <Select
          id="homeLocationId"
          name="homeLocationId"
          required
          key={locations.data?.length ?? 0}
          defaultValue={locations.data?.find((l) => l.kind === 'crib')?.id}
        >
          {locations.data?.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      </Field>

      <label className="flex items-center gap-3 rounded-md border border-line px-3 py-3">
        <input type="checkbox" checked={cal} onChange={(e) => setCal(e.target.checked)} className="size-5 accent-machine" />
        <span>
          <span className="block font-semibold">Needs regular calibration</span>
          <span className="block text-sm text-muted">It will be locked automatically when calibration expires.</span>
        </span>
      </label>
      {cal && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Calibrate every (days)" htmlFor="interval">
            <Input id="interval" name="interval" type="number" min={1} max={3650} defaultValue={180} required />
          </Field>
          <Field label="Last calibrated" htmlFor="lastCalibratedOn">
            <Input id="lastCalibratedOn" name="lastCalibratedOn" type="date" max={todayIso()} required />
          </Field>
        </div>
      )}
      <ErrorNote>{error}</ErrorNote>
      <Button type="submit" busy={create.isPending}>
        Add to the board
      </Button>
    </form>
  );
}

export default function ToolsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <ToolsList />
    </Suspense>
  );
}
