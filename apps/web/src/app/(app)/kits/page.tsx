'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Briefcase } from 'lucide-react';
import { Suspense, useState, type FormEvent } from 'react';
import { KitStateBadge } from '@/components/kit-state';
import { toast } from '@/components/toast';
import { AssetTag } from '@/components/tool-visuals';
import { Button, Dialog, ErrorNote, Field, Input, PageHeader, Panel, Select, Spinner } from '@/components/ui';
import { errorText } from '@/lib/api';
import { relative } from '@/lib/format';
import { useCreateKit, useKits, useLocations } from '@/lib/queries';
import { can, useMe } from '@/lib/session';

function KitsPage() {
  const { data: me } = useMe();
  const kits = useKits();
  const router = useRouter();
  const params = useSearchParams();
  const adding = params.get('add') === '1' && can.manageTools(me?.role);

  return (
    <>
      <PageHeader
        title="Kits"
        sub="Sets of tools that go out together, with one scan, and come back checked piece by piece."
        actions={can.manageTools(me?.role) && <Button onClick={() => router.replace('/kits?add=1')}>Make a kit</Button>}
      />
      {kits.isLoading ? (
        <Spinner />
      ) : kits.isError ? (
        <ErrorNote>{errorText(kits.error)}</ErrorNote>
      ) : kits.data!.length === 0 ? (
        <Panel className="flex flex-col items-center gap-2 px-6 py-14 text-center">
          <Briefcase className="size-8 text-muted" aria-hidden />
          <p className="text-lg">No kits yet.</p>
          <p className="text-muted">Group tools that always go out together, like an electrician&apos;s kit or a socket set.</p>
        </Panel>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {kits.data!.map((k) => {
            return (
              <li key={k.id}>
                <Link href={`/kits/${k.id}`} className={`flex h-full flex-col gap-3 rounded-xl border-2 border-ink/15 bg-panel p-4 hover:border-machine ${k.isActive ? '' : 'opacity-60'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <AssetTag tag={k.assetTag} />
                    <Briefcase className="size-6 text-muted" aria-hidden />
                  </div>
                  <div>
                    <div className="font-semibold">{k.name}</div>
                    <div className="text-sm text-muted">
                      {k.toolCount} {k.toolCount === 1 ? 'tool' : 'tools'}, kept at {k.homeLocationName}
                    </div>
                  </div>
                  <div className="mt-auto flex flex-wrap items-center gap-2 text-sm">
                    <KitStateBadge state={k.state} />
                    {k.holderName && (
                      <span className="text-muted">
                        {k.holderName}
                        {k.dueBackAt ? `, due ${relative(k.dueBackAt)}` : ''}
                      </span>
                    )}
                    {!k.isActive && <span className="text-muted">Not in use</span>}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <Dialog open={adding} onClose={() => router.replace('/kits')} title="Make a kit">
        <NewKitForm onDone={(id) => router.replace(`/kits/${id}`)} />
      </Dialog>
    </>
  );
}

function NewKitForm({ onDone }: { onDone: (id: string) => void }) {
  const create = useCreateKit();
  const locations = useLocations();
  const [error, setError] = useState('');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const f = new FormData(e.currentTarget);
    const tags = String(f.get('toolTags'))
      .split(/[\s,;]+/)
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean);
    try {
      const { kit } = await create.mutateAsync({
        assetTag: String(f.get('assetTag')).trim().toUpperCase(),
        name: String(f.get('name')).trim(),
        homeLocationId: String(f.get('homeLocationId')),
        toolTags: tags,
      });
      toast(`Kit ${kit.assetTag} made with ${kit.tools.length} tools`);
      onDone(kit.id);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <Field label="Kit tag" htmlFor="kitTag" hint="Its own QR label, e.g. KIT-0002">
        <Input id="kitTag" name="assetTag" required pattern="[A-Za-z0-9][A-Za-z0-9\-]{2,31}" className="tag-plate uppercase" />
      </Field>
      <Field label="Kept at" htmlFor="kitLocation">
        <Select id="kitLocation" name="homeLocationId" required key={locations.data?.length ?? 0} defaultValue={locations.data?.find((l) => l.kind === 'crib')?.id}>
          {locations.data?.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="sm:col-span-2">
        <Field label="Name" htmlFor="kitName">
          <Input id="kitName" name="name" required maxLength={120} placeholder="Electrician's kit" />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field label="Tools in it (asset tags)" htmlFor="toolTags" hint="Separated by spaces or commas. You can add more later.">
          <Input id="toolTags" name="toolTags" placeholder="AK-0901, CC-0902, CP-0903" className="uppercase" />
        </Field>
      </div>
      <div className="flex flex-col gap-3 sm:col-span-2">
        <ErrorNote>{error}</ErrorNote>
        <Button type="submit" busy={create.isPending}>
          Make the kit
        </Button>
      </div>
    </form>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Spinner />}>
      <KitsPage />
    </Suspense>
  );
}
