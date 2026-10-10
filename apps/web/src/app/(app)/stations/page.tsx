'use client';

import { Copy, KeyRound, ShieldAlert, ShieldCheck, Terminal } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from '@/components/toast';
import { Button, ErrorNote, Field, Input, PageHeader, Panel, Select, Spinner } from '@/components/ui';
import { errorText } from '@/lib/api';
import { formatDateTime, relative } from '@/lib/format';
import { useCreateStation, useLocations, useRotateStationKey, useStationEvents, useStations, useUpdateStation } from '@/lib/queries';
import { can, useMe } from '@/lib/session';
import type { Provisioning, Station, StationEvent } from '@/lib/types';

export default function StationsPage() {
  const { data: me } = useMe();
  const allowed = can.seeStations(me?.role);
  const admin = can.manageStations(me?.role);
  const stations = useStations(allowed);
  const [provisioned, setProvisioned] = useState<{ name: string; p: Provisioning } | null>(null);

  if (!allowed) return <ErrorNote>Only admins, storekeepers and auditors can see stations.</ErrorNote>;

  return (
    <>
      <PageHeader
        title="Stations"
        sub="RFID stations at the crib window. Tap a badge, then a tool: it's checked out. Tap it again: it's returned."
      />

      {stations.data && !stations.data.enabled && (
        <div className="mb-6 rounded-lg border-2 border-dashed border-line bg-panel p-5">
          <h2 className="text-xl font-semibold">Stations are switched off on this server</h2>
          <p className="mt-1 text-muted">
            Set <code className="rounded bg-board px-1">STATION_MASTER_KEY</code> on the API (32 random bytes, hex) and
            restart it. Every station&apos;s key is derived from it, so no station secrets are ever stored.
          </p>
        </div>
      )}

      {provisioned && <ProvisioningPanel name={provisioned.name} p={provisioned.p} onDone={() => setProvisioned(null)} />}

      <section aria-labelledby="stations-h" className="mb-8">
        <h2 id="stations-h" className="sr-only">
          All stations
        </h2>
        {stations.isLoading ? (
          <Spinner />
        ) : stations.isError ? (
          <ErrorNote>{errorText(stations.error)}</ErrorNote>
        ) : stations.data!.stations.length === 0 ? (
          <p className="rounded-lg border border-line bg-panel px-4 py-8 text-center text-muted">
            No stations yet.{admin ? ' Add one below to get its setup details.' : ''}
          </p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
            {stations.data!.stations.map((s) => (
              <StationRow key={s.id} station={s} admin={admin} onKey={(p) => setProvisioned({ name: s.name, p })} />
            ))}
          </ul>
        )}
      </section>

      {admin && stations.data?.enabled && <AddStation onCreated={(name, p) => setProvisioned({ name, p })} />}

      <ActivityLog />
    </>
  );
}

function StationRow({ station, admin, onKey }: { station: Station; admin: boolean; onKey: (p: Provisioning) => void }) {
  const rotate = useRotateStationKey();
  const update = useUpdateStation();
  return (
    <li className={`flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center ${station.isActive ? '' : 'opacity-60'}`}>
      <span
        className={`size-3 shrink-0 rounded-full ${station.online && station.isActive ? 'bg-ok' : 'bg-line'}`}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{station.name}</div>
        <div className="text-sm text-muted">
          {station.locationName}.{' '}
          {!station.isActive
            ? 'Switched off.'
            : station.online
              ? 'Online.'
              : station.lastSeenAt
                ? `Offline, last seen ${relative(station.lastSeenAt)}.`
                : 'Never connected.'}{' '}
          Key version {station.keyVersion}.
        </div>
      </div>
      {admin && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="quiet"
            busy={rotate.isPending}
            onClick={async () => {
              if (!window.confirm(`Issue a new key for ${station.name}? The current key stops working immediately.`)) return;
              try {
                const res = (await rotate.mutateAsync(station.id)) as { provisioning: Provisioning };
                onKey(res.provisioning);
              } catch (err) {
                toast(errorText(err), 'error');
              }
            }}
          >
            <KeyRound className="size-4" aria-hidden /> New key
          </Button>
          <Button
            variant="quiet"
            busy={update.isPending}
            onClick={async () => {
              await update.mutateAsync({ id: station.id, isActive: !station.isActive }).catch((e) => toast(errorText(e), 'error'));
              toast(station.isActive ? `${station.name} switched off` : `${station.name} switched on`);
            }}
          >
            {station.isActive ? 'Switch off' : 'Switch on'}
          </Button>
        </div>
      )}
    </li>
  );
}

function AddStation({ onCreated }: { onCreated: (name: string, p: Provisioning) => void }) {
  const locations = useLocations();
  const create = useCreateStation();
  const [error, setError] = useState('');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const form = e.currentTarget;
    const f = new FormData(form);
    const name = String(f.get('name')).trim();
    try {
      const res = (await create.mutateAsync({ name, locationId: String(f.get('locationId')) })) as { provisioning: Provisioning };
      onCreated(name, res.provisioning);
      form.reset();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Panel className="mb-8 p-5">
      <h2 className="text-2xl font-semibold">Add a station</h2>
      <form onSubmit={submit} className="mt-4 grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="Station name" htmlFor="station-name">
          <Input id="station-name" name="name" required maxLength={60} placeholder="Crib Station 1" />
        </Field>
        <Field label="Where it is" htmlFor="station-location">
          <Select
            id="station-location"
            name="locationId"
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
        <Button type="submit" busy={create.isPending}>
          Add station
        </Button>
      </form>
      <div className="mt-3">
        <ErrorNote>{error}</ErrorNote>
      </div>
    </Panel>
  );
}

/** The station key is derived on the server and shown exactly once. */
function ProvisioningPanel({ name, p, onDone }: { name: string; p: Provisioning; onDone: () => void }) {
  const sim = `npm run station -w apps/api -- --id ${p.stationId} --key ${p.stationKey}`;
  const copy = async (text: string, what: string) => {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  };
  return (
    <section aria-labelledby="prov-h" className="mb-8 rounded-lg border-2 border-machine bg-panel p-5">
      <h2 id="prov-h" className="text-2xl font-semibold">
        Set up {name}
      </h2>
      <p className="mt-1 text-muted">
        This key is shown only now. If it&apos;s lost, issue a new key; the old one stops working at once.
      </p>

      <h3 className="mt-5 font-semibold">For the ESP32 firmware: paste into config.h</h3>
      <div className="relative mt-2">
        <pre aria-label="Firmware settings" className="overflow-x-auto rounded-md bg-ink p-4 pr-24 text-sm leading-relaxed text-panel">
          {p.firmwareConfig}
        </pre>
        <Button variant="quiet" className="absolute right-2 top-2 bg-panel" onClick={() => copy(p.firmwareConfig, 'Firmware settings')}>
          <Copy className="size-4" aria-hidden /> Copy
        </Button>
      </div>

      <h3 className="mt-5 flex items-center gap-2 font-semibold">
        <Terminal className="size-4" aria-hidden /> No hardware? Run a station in your terminal
      </h3>
      <div className="relative mt-2">
        <pre aria-label="Simulator command" className="overflow-x-auto rounded-md bg-board p-4 pr-24 text-sm">
          {sim}
        </pre>
        <Button variant="quiet" className="absolute right-2 top-2 bg-panel" onClick={() => copy(sim, 'Command')}>
          <Copy className="size-4" aria-hidden /> Copy
        </Button>
      </div>

      <Button className="mt-5" onClick={onDone}>
        I&apos;ve saved it
      </Button>
    </section>
  );
}

const describe = (e: StationEvent): string => {
  const who = e.userName ?? 'Someone';
  const tag = e.assetTag ?? 'A tool';
  switch (e.code) {
    case 'hello':
      return 'Station checked in';
    case 'badge_ok':
      return `${who} badged in`;
    case 'checked_out':
      return `${who} took ${tag}`;
    case 'returned':
      return `${tag} returned by ${who}`;
    case 'returned_problem':
      return `${tag} returned with a problem and quarantined`;
    case 'calibration_expired':
      return `${tag} refused: calibration expired`;
    case 'tool_unavailable':
      return `${tag} refused: not available`;
    case 'badge_first':
      return `${tag} tapped before a badge`;
    case 'unknown_tag':
      return `Unknown tag ${e.uid ?? ''}. Assign it as a badge on People, or as a tool tag on the tool's page.`;
    case 'badge_not_allowed':
      return `${who}'s badge was refused`;
    case 'bad_signature':
      return 'Forged or altered message rejected';
    case 'replay':
      return 'Replayed message rejected';
    case 'stale_clock':
      return "Message rejected: the station's clock is wrong";
    case 'malformed':
      return 'Unreadable message rejected';
    case 'rate_limited':
      return 'Too many messages: slowed down';
    case 'station_inactive':
      return 'Message from a switched-off station ignored';
    case 'bad_uid':
      return 'Tag could not be read';
    default:
      return e.code;
  }
};

const SECURITY_CODES = new Set(['bad_signature', 'replay', 'stale_clock', 'malformed', 'rate_limited', 'station_inactive']);

function ActivityLog() {
  const events = useStationEvents(true);
  return (
    <section aria-labelledby="log-h">
      <h2 id="log-h" className="mb-3 text-2xl font-semibold">
        Station activity
      </h2>
      {events.isLoading ? (
        <Spinner />
      ) : events.isError ? (
        <ErrorNote>{errorText(events.error)}</ErrorNote>
      ) : events.data!.length === 0 ? (
        <p className="rounded-lg border border-line bg-panel px-4 py-8 text-center text-muted">Nothing has happened at a station yet.</p>
      ) : (
        <ol className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
          {events.data!.map((e) => {
            const security = SECURITY_CODES.has(e.code);
            return (
              <li key={e.id} className="flex gap-3 px-4 py-3 text-sm">
                {security ? (
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-signal" aria-label="Security" />
                ) : (
                  <ShieldCheck
                    className={`mt-0.5 size-4 shrink-0 ${e.outcome === 'accepted' ? 'text-ok' : 'text-muted'}`}
                    aria-label={e.outcome === 'accepted' ? 'Accepted' : 'Refused'}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className={security ? 'font-semibold text-signal' : ''}>{describe(e)}</p>
                  <p className="text-muted">
                    {e.stationName}, {formatDateTime(e.receivedAt)}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
