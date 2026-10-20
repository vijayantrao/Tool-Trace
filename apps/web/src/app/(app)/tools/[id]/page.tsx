'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Briefcase, ClipboardList, Lock, Pencil, QrCode } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { AckButtons, AckLine } from '@/components/ack';
import { AttachCertificate, CertificateLink, LabPanel, SendToLabForm } from '@/components/calibration-lab';
import { PriceTag } from '@/components/price-tag';
import { RequestForm } from '@/components/request-form';
import { AssetTag, CalSticker, StatusTag, toolIcon } from '@/components/tool-visuals';
import { DuePicker } from '@/components/due-picker';
import { TagEditor } from '@/components/tag-editor';
import { toast } from '@/components/toast';
import { Button, Dialog, ErrorNote, Field, Input, Panel, Select, Spinner } from '@/components/ui';
import { ApiError, apiForm, errorText } from '@/lib/api';
import { useOffline } from '@/lib/offline';
import { newCheckoutItem } from '@/lib/outbox';
import { formatDateTime, formatDay, relative, todayIso } from '@/lib/format';
import {
  useCheckOut,
  useHolders,
  useLocations,
  useRecordCalibration,
  useReturn,
  useSetToolTag,
  useTool,
  useUpdateTool,
  useUpdateToolStatus,
} from '@/lib/queries';
import { can, useMe } from '@/lib/session';
import type { Me, ReturnCondition, ToolDetail } from '@/lib/types';

export default function ToolPage() {
  const { id } = useParams<{ id: string }>();
  const { data: me } = useMe();
  const { data: tool, isLoading, isError, error } = useTool(id);
  const setTag = useSetToolTag();

  if (isLoading) return <Spinner />;
  if (isError || !tool) return <ErrorNote>{errorText(error)}</ErrorNote>;

  const Icon = toolIcon(tool.category);
  const locked = tool.calibrationState === 'expired';
  const makeModel = [tool.make, tool.model].filter(Boolean).join(' ');

  return (
    <div className="max-w-3xl">
      <Link href="/" className="mb-5 inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> Board
      </Link>

      <header className="mb-6 flex items-start gap-4">
        <div className="hidden size-20 shrink-0 place-items-center rounded-xl border-2 border-ink/15 bg-panel sm:grid">
          <Icon className="size-11" strokeWidth={1.6} aria-hidden />
        </div>
        <div className="min-w-0">
          <AssetTag tag={tool.assetTag} size="lg" />
          <h1 className="mt-2 text-[1.9rem] font-semibold md:text-[2.3rem]">{tool.name}</h1>
          <p className="text-muted">
            {tool.category}
            {makeModel ? `, ${makeModel}` : ''}, kept at {tool.homeLocationName}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <StatusTag status={tool.status} />
            <CalSticker state={tool.calibrationState} dueOn={tool.calibrationDueOn} size="md" />
            <PriceTag price={tool.unitPrice} abcClass={tool.abcClass} />
            {tool.kit && (
              <Link
                href={`/kits/${tool.kit.id}`}
                className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-sm font-semibold ring-1 ring-inset ring-line hover:bg-panel"
              >
                <Briefcase className="size-3.5" aria-hidden /> In kit {tool.kit.assetTag}
              </Link>
            )}
          </div>
        </div>
      </header>

      <div className="flex flex-col gap-5">
        {tool.status === 'checked_out' && tool.openCheckout && <HolderPanel tool={tool} me={me!} />}
        {tool.status === 'at_calibration' && <LabPanel tool={tool} canManage={can.manageTools(me?.role)} />}
        {tool.status === 'available' && locked && <LockedPanel tool={tool} />}
        {tool.status === 'available' && !locked && can.checkOut(me?.role) && <CheckOutPanel tool={tool} me={me!} />}
        {tool.status === 'quarantined' && <QuarantinePanel tool={tool} me={me!} />}
        {tool.requiresCalibration && <CalibrationPanel tool={tool} me={me!} />}
        <TagEditor
          label="RFID tag"
          value={tool.rfidUid}
          canEdit={can.manageTools(me?.role)}
          onSave={(rfidUid) => setTag.mutateAsync({ id: tool.id, rfidUid })}
          savedMessage={(uid) => (uid ? `RFID tag assigned to ${tool.assetTag}` : `RFID tag removed from ${tool.assetTag}`)}
        />
        <ManagePanel tool={tool} me={me!} />
      </div>
    </div>
  );
}

/* ---------- Check out ---------- */


function CheckOutPanel({ tool, me }: { tool: ToolDetail; me: Me }) {
  const issue = can.issueToOthers(me.role);
  const holders = useHolders(issue);
  const checkOut = useCheckOut();
  const offline = useOffline();
  const [hours, setHours] = useState(8);
  const [holderId, setHolderId] = useState(me.id);
  const [error, setError] = useState('');
  const due = useMemo(() => new Date(Date.now() + hours * 3_600_000), [hours]);

  // No connection: save it on the phone and send it later (only for yourself).
  async function saveOffline(): Promise<boolean> {
    if (!offline || holderId !== me.id) {
      setError('No connection. Issuing a tool to someone else needs a connection.');
      return false;
    }
    await offline.queue(newCheckoutItem(me.id, tool.assetTag, hours));
    toast(`Saved offline: ${tool.assetTag} will be checked out to you when you're back online`, 'info');
    return true;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (offline && !offline.online) {
      await saveOffline();
      return;
    }
    try {
      await checkOut.mutateAsync({ toolId: tool.id, holderId, dueBackAt: due.toISOString() });
      const who = holderId === me.id ? 'you' : holders.data?.find((h) => h.id === holderId)?.displayName;
      toast(`Checked out ${tool.assetTag} to ${who}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) await saveOffline();
      else setError(errorText(err));
    }
  }

  return (
    <Panel className="p-5">
      <h2 className="text-2xl font-semibold">Check out</h2>
      {tool.kit && (
        <p className="mt-1 text-sm text-muted">
          Part of kit {tool.kit.assetTag}.{' '}
          <Link href={`/kits/${tool.kit.id}`} className="font-semibold text-ink underline">
            Check out the whole kit
          </Link>{' '}
          or just this tool.
        </p>
      )}
      <form onSubmit={submit} className="mt-4 flex flex-col gap-5">
        {issue && (
          <Field label="Issue to" htmlFor="holder">
            <Select id="holder" value={holderId} onChange={(e) => setHolderId(e.target.value)}>
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
        <Button type="submit" busy={checkOut.isPending} className="sm:self-start">
          Check out {tool.assetTag}
        </Button>
      </form>
    </Panel>
  );
}

/* ---------- Currently out ---------- */

const conditions: { value: ReturnCondition; label: string; hint: string }[] = [
  { value: 'ok', label: 'Good', hint: 'Goes straight back on the board' },
  { value: 'damaged', label: 'Damaged', hint: 'Quarantined until repaired' },
  { value: 'needs_calibration', label: 'Needs calibration', hint: 'Quarantined until recalibrated' },
];

function HolderPanel({ tool, me }: { tool: ToolDetail; me: Me }) {
  const c = tool.openCheckout!;
  const ret = useReturn();
  const offline = useOffline();
  const [condition, setCondition] = useState<ReturnCondition>('ok');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');

  async function saveOffline() {
    if (!offline) return;
    await offline.queue({
      id: crypto.randomUUID(),
      userId: me.id,
      kind: 'return',
      assetTag: tool.assetTag,
      checkoutId: c.id,
      condition,
      notes: notes.trim() || undefined,
      queuedAt: new Date().toISOString(),
      state: 'pending',
    });
    toast(`Saved offline: ${tool.assetTag} will be received when you're back online`, 'info');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (offline && !offline.online) {
      await saveOffline();
      return;
    }
    try {
      await ret.mutateAsync({ id: c.id, condition, notes: notes.trim() || undefined });
      toast(condition === 'ok' ? `${tool.assetTag} is back on the board` : `${tool.assetTag} returned and quarantined`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) await saveOffline();
      else setError(errorText(err));
    }
  }

  return (
    <Panel className={`p-5 ${c.overdue ? 'border-signal' : ''}`}>
      <h2 className="text-2xl font-semibold">{c.holderId === me.id ? 'You have this tool' : `With ${c.holderName}`}</h2>
      <p className="mt-1 text-muted">
        Since {formatDateTime(c.checkedOutAt)}.{' '}
        <span className={c.overdue ? 'font-semibold text-signal' : ''}>
          {c.overdue ? 'Overdue: was due ' : 'Due back '}
          {relative(c.dueBackAt)}.
        </span>
      </p>
      {c.acknowledgement && (
        <div className="mt-3 flex flex-col gap-2">
          <AckLine
            status={c.acknowledgement.status}
            who={c.holderId === me.id ? 'you' : c.holderName}
            respondedAt={c.acknowledgement.respondedAt}
            note={c.acknowledgement.note}
          />
          {c.acknowledgement.status === 'pending' && c.holderId === me.id && <AckButtons id={c.acknowledgement.id} />}
        </div>
      )}

      {can.receiveReturns(me.role) ? (
        <form onSubmit={submit} className="mt-5 flex flex-col gap-4 border-t border-line pt-5">
          <fieldset>
            <legend className="mb-2 font-semibold">Receive return: condition</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {conditions.map((o) => (
                <label
                  key={o.value}
                  className={`flex cursor-pointer flex-col rounded-md p-3 ring-1 ring-inset ${
                    condition === o.value ? 'bg-board ring-2 ring-machine' : 'ring-line'
                  }`}
                >
                  <input
                    type="radio"
                    name="condition"
                    value={o.value}
                    checked={condition === o.value}
                    onChange={() => setCondition(o.value)}
                    className="sr-only"
                  />
                  <span className="font-semibold">{o.label}</span>
                  <span className="text-sm text-muted">{o.hint}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Notes (optional)" htmlFor="notes">
            <Input
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
              placeholder={condition === 'ok' ? '' : 'What is wrong with it?'}
            />
          </Field>
          <ErrorNote>{error}</ErrorNote>
          <Button type="submit" busy={ret.isPending} className="sm:self-start">
            Receive {tool.assetTag}
          </Button>
        </form>
      ) : (
        c.holderId === me.id && (
          <p className="mt-4 text-sm text-muted">Hand it back at the crib window. The storekeeper will check it in.</p>
        )
      )}
    </Panel>
  );
}

/* ---------- Locked / quarantined ---------- */

function LockedPanel({ tool }: { tool: ToolDetail }) {
  return (
    <div className="flex gap-3 rounded-lg border-2 border-signal bg-signal-soft p-5">
      <Lock className="mt-0.5 size-6 shrink-0 text-signal" aria-hidden />
      <div>
        <h2 className="text-xl font-semibold">Locked: calibration expired</h2>
        <p className="mt-1">
          Calibration ran out on {tool.calibrationDueOn ? formatDay(tool.calibrationDueOn) : 'an earlier date'}. It can&apos;t
          be checked out until a new calibration is recorded.
        </p>
      </div>
    </div>
  );
}

function QuarantinePanel({ tool, me }: { tool: ToolDetail; me: Me }) {
  const update = useUpdateToolStatus();
  return (
    <div className="rounded-lg border-2 border-signal bg-signal-soft p-5">
      <h2 className="text-xl font-semibold">Quarantined</h2>
      <p className="mt-1">
        This tool is off the floor until it&apos;s inspected.
        {tool.requiresCalibration ? ' Recording a new calibration releases it automatically.' : ''}
      </p>
      {can.manageTools(me.role) && (
        <Button
          variant="quiet"
          className="mt-4 bg-panel"
          busy={update.isPending}
          onClick={async () => {
            try {
              await update.mutateAsync({ id: tool.id, status: 'available' });
              toast(`${tool.assetTag} released back to the board`);
            } catch (err) {
              toast(errorText(err), 'error');
            }
          }}
        >
          Inspected: release to the board
        </Button>
      )}
    </div>
  );
}

/* ---------- Calibration ---------- */

function CalibrationPanel({ tool, me }: { tool: ToolDetail; me: Me }) {
  const record = useRecordCalibration();
  const staff = can.manageTools(me.role);
  const [mode, setMode] = useState<'none' | 'record' | 'send'>(tool.calibrationState === 'expired' && staff && tool.status !== 'at_calibration' ? 'send' : 'none');
  const [error, setError] = useState('');
  const canRecord = staff && tool.status !== 'checked_out' && tool.status !== 'at_calibration';
  const canSend = staff && (tool.status === 'available' || tool.status === 'quarantined');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const f = new FormData(e.currentTarget);
    const file = f.get('certificate');
    try {
      const { tool: t } = await record.mutateAsync({
        id: tool.id,
        calibratedOn: String(f.get('calibratedOn')),
        performedBy: String(f.get('performedBy')).trim(),
        certificateRef: String(f.get('certificateRef')).trim() || undefined,
      });
      if (file instanceof File && file.size > 0 && t.calibrations[0]) {
        const form = new FormData();
        form.append('certificate', file);
        await apiForm(`/calibration-records/${t.calibrations[0].id}/certificate`, form).catch((err) => {
          toast(`Calibration saved, but the certificate was not: ${errorText(err)}`, 'error');
        });
      }
      toast(`Calibration recorded. Next due ${t.calibrationDueOn ? formatDay(t.calibrationDueOn) : ''}`);
      setMode('none');
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Panel className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold">Calibration</h2>
        {mode === 'none' && (
          <div className="flex flex-wrap gap-2">
            {canSend && (
              <Button variant="quiet" onClick={() => setMode('send')}>
                Send for calibration
              </Button>
            )}
            {canRecord && (
              <Button variant="quiet" onClick={() => setMode('record')}>
                Record calibration
              </Button>
            )}
          </div>
        )}
      </div>
      <p className="mt-1 text-muted">
        Every {tool.calibrationIntervalDays} days.{' '}
        {tool.calibrationDueOn && `Next due ${formatDay(tool.calibrationDueOn)}.`}
      </p>

      {/* Stays open once the tool is at the lab, so the one-time link can still be copied. */}
      {mode === 'send' && (canSend || tool.status === 'at_calibration') && <SendToLabForm tool={tool} onClose={() => setMode('none')} />}

      {mode === 'record' && canRecord && (
        <form onSubmit={submit} className="mt-4 grid gap-4 rounded-md bg-board p-4 sm:grid-cols-2">
          <Field label="Calibration date" htmlFor="calibratedOn">
            <Input id="calibratedOn" name="calibratedOn" type="date" max={todayIso()} defaultValue={todayIso()} required />
          </Field>
          <Field label="Calibrated by" htmlFor="performedBy">
            <Input id="performedBy" name="performedBy" required maxLength={120} placeholder="External Calibration Lab" />
          </Field>
          <Field label="Certificate number (optional)" htmlFor="certificateRef">
            <Input id="certificateRef" name="certificateRef" maxLength={120} placeholder="CAL-2026-0042" />
          </Field>
          <Field label="Certificate file (optional)" htmlFor="certificateFile" hint="PDF, JPEG or PNG, up to 3 MB.">
            <Input id="certificateFile" name="certificate" type="file" accept="application/pdf,image/jpeg,image/png" className="py-2" />
          </Field>
          <div className="flex flex-col gap-3 sm:col-span-2">
            <ErrorNote>{error}</ErrorNote>
            <div className="flex gap-2">
              <Button type="submit" busy={record.isPending}>
                Save calibration
              </Button>
              <Button type="button" variant="quiet" onClick={() => setMode('none')}>
                Cancel
              </Button>
            </div>
          </div>
        </form>
      )}

      {tool.calibrations.length > 0 ? (
        <ol className="mt-4 divide-y divide-line border-t border-line">
          {tool.calibrations.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3 text-sm">
              <span>
                <span className="font-semibold">{formatDay(c.calibratedOn)}</span> by {c.performedBy}
              </span>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted">
                <span>
                  {c.certificateRef ? `Cert ${c.certificateRef}, ` : ''}valid to {formatDay(c.dueOn)}
                </span>
                {c.certificateFile ? (
                  <CertificateLink recordId={c.id} fileName={c.certificateFile} />
                ) : (
                  staff && <AttachCertificate recordId={c.id} />
                )}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 text-sm text-muted">No calibrations recorded in ToolTrace yet.</p>
      )}
    </Panel>
  );
}

/* ---------- Manage ---------- */

function ManagePanel({ tool, me }: { tool: ToolDetail; me: Me }) {
  const update = useUpdateToolStatus();
  const [editing, setEditing] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const staff = can.manageTools(me.role);
  const set = async (status: 'quarantined' | 'retired' | 'available', msg: string) => {
    try {
      await update.mutateAsync({ id: tool.id, status });
      toast(msg);
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };
  if (!staff && !can.makeRequests(me.role)) return null;
  return (
    <div className="flex flex-wrap gap-2 border-t border-line pt-5">
      {staff && (
        <>
          <Link
            href={`/labels?ids=${tool.id}`}
            className="inline-flex min-h-11 items-center gap-2 rounded-md px-4 font-semibold ring-1 ring-inset ring-line hover:bg-panel"
          >
            <QrCode className="size-4" aria-hidden /> Print QR label
          </Link>
          <Button variant="quiet" onClick={() => setEditing(true)}>
            <Pencil className="size-4" aria-hidden /> Edit details
          </Button>
        </>
      )}
      {can.makeRequests(me.role) && tool.status !== 'retired' && (
        <Button variant="quiet" onClick={() => setRequesting(true)}>
          <ClipboardList className="size-4" aria-hidden /> Request replacement
        </Button>
      )}
      {staff && tool.status === 'available' && (
        <Button variant="quiet" onClick={() => set('quarantined', `${tool.assetTag} quarantined`)}>
          Quarantine
        </Button>
      )}
      {staff && tool.status !== 'checked_out' && tool.status !== 'retired' && tool.status !== 'at_calibration' && (
        <Button variant="quiet" onClick={() => set('retired', `${tool.assetTag} retired`)}>
          Retire
        </Button>
      )}
      {staff && tool.status === 'retired' && (
        <Button variant="quiet" onClick={() => set('available', `${tool.assetTag} back in service`)}>
          Return to service
        </Button>
      )}
      <Dialog open={editing} onClose={() => setEditing(false)} title={`Edit ${tool.assetTag}`}>
        <EditDetails tool={tool} onDone={() => setEditing(false)} />
      </Dialog>
      <Dialog open={requesting} onClose={() => setRequesting(false)} title={`Replace ${tool.assetTag}`}>
        <RequestForm tool={tool} onDone={() => setRequesting(false)} />
      </Dialog>
    </div>
  );
}

function EditDetails({ tool, onDone }: { tool: ToolDetail; onDone: () => void }) {
  const update = useUpdateTool();
  const locations = useLocations();
  const [error, setError] = useState('');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const price = text('unitPrice');
    try {
      await update.mutateAsync({
        id: tool.id,
        name: text('name'),
        category: text('category'),
        homeLocationId: text('homeLocationId'),
        make: text('make') || null,
        model: text('model') || null,
        unitPrice: price ? Number(price) : null,
      });
      toast(`${tool.assetTag} updated`);
      onDone();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <Field label="Name" htmlFor="editName">
          <Input id="editName" name="name" required maxLength={120} defaultValue={tool.name} />
        </Field>
      </div>
      <Field label="Category" htmlFor="editCategory">
        <Input id="editCategory" name="category" required maxLength={60} defaultValue={tool.category} />
      </Field>
      <Field label="Kept at" htmlFor="editLocation">
        <Select id="editLocation" name="homeLocationId" defaultValue={tool.homeLocationId}>
          {locations.data?.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Make (optional)" htmlFor="editMake">
        <Input id="editMake" name="make" maxLength={80} defaultValue={tool.make ?? ''} placeholder="Norbar" />
      </Field>
      <Field label="Model (optional)" htmlFor="editModel">
        <Input id="editModel" name="model" maxLength={80} defaultValue={tool.model ?? ''} placeholder="TTi 100" />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Unit price (optional)" htmlFor="editPrice" hint="Sets the class: A above 15,000, B from 2,000 to 15,000, C below 2,000.">
          <Input id="editPrice" name="unitPrice" type="number" min={0} step="0.01" inputMode="decimal" defaultValue={tool.unitPrice ?? ''} />
        </Field>
      </div>
      <div className="flex flex-col gap-3 sm:col-span-2">
        <ErrorNote>{error}</ErrorNote>
        <div className="flex gap-2">
          <Button type="submit" busy={update.isPending}>
            Save
          </Button>
          <Button type="button" variant="quiet" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </div>
    </form>
  );
}
