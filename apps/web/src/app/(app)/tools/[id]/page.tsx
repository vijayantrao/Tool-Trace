'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Lock, QrCode } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { AssetTag, CalSticker, StatusTag, toolIcon } from '@/components/tool-visuals';
import { TagEditor } from '@/components/tag-editor';
import { toast } from '@/components/toast';
import { Button, ErrorNote, Field, Input, Panel, Select, Spinner } from '@/components/ui';
import { errorText } from '@/lib/api';
import { formatDateTime, formatDay, relative, todayIso } from '@/lib/format';
import { useCheckOut, useHolders, useRecordCalibration, useReturn, useSetToolTag, useTool, useUpdateToolStatus } from '@/lib/queries';
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
            {tool.category}, kept at {tool.homeLocationName}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <StatusTag status={tool.status} />
            <CalSticker state={tool.calibrationState} dueOn={tool.calibrationDueOn} size="md" />
          </div>
        </div>
      </header>

      <div className="flex flex-col gap-5">
        {tool.status === 'checked_out' && tool.openCheckout && <HolderPanel tool={tool} me={me!} />}
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
        {can.manageTools(me?.role) && <ManagePanel tool={tool} />}
      </div>
    </div>
  );
}

/* ---------- Check out ---------- */

const quickDue = [
  { label: 'End of shift', hours: 8 },
  { label: 'Tomorrow', hours: 24 },
  { label: '3 days', hours: 72 },
  { label: '1 week', hours: 168 },
];

function CheckOutPanel({ tool, me }: { tool: ToolDetail; me: Me }) {
  const issue = can.issueToOthers(me.role);
  const holders = useHolders(issue);
  const checkOut = useCheckOut();
  const [hours, setHours] = useState(8);
  const [holderId, setHolderId] = useState(me.id);
  const [error, setError] = useState('');
  const due = useMemo(() => new Date(Date.now() + hours * 3_600_000), [hours]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await checkOut.mutateAsync({ toolId: tool.id, holderId, dueBackAt: due.toISOString() });
      const who = holderId === me.id ? 'you' : holders.data?.find((h) => h.id === holderId)?.displayName;
      toast(`Checked out ${tool.assetTag} to ${who}`);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Panel className="p-5">
      <h2 className="text-2xl font-semibold">Check out</h2>
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
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">Due back</legend>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            {quickDue.map((q) => (
              <button
                type="button"
                key={q.hours}
                onClick={() => setHours(q.hours)}
                aria-pressed={hours === q.hours}
                className={`min-h-11 rounded-md px-3 text-sm font-semibold ${
                  hours === q.hours ? 'bg-ink text-panel' : 'ring-1 ring-inset ring-line hover:ring-ink/40'
                }`}
              >
                {q.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-sm text-muted">Due {formatDateTime(due.toISOString())}</p>
        </fieldset>
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
  const [condition, setCondition] = useState<ReturnCondition>('ok');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await ret.mutateAsync({ id: c.id, condition, notes: notes.trim() || undefined });
      toast(condition === 'ok' ? `${tool.assetTag} is back on the board` : `${tool.assetTag} returned and quarantined`);
    } catch (err) {
      setError(errorText(err));
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
  const [open, setOpen] = useState(tool.calibrationState === 'expired');
  const [error, setError] = useState('');
  const canRecord = can.manageTools(me.role) && tool.status !== 'checked_out';

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const f = new FormData(e.currentTarget);
    try {
      const { tool: t } = await record.mutateAsync({
        id: tool.id,
        calibratedOn: String(f.get('calibratedOn')),
        performedBy: String(f.get('performedBy')).trim(),
        certificateRef: String(f.get('certificateRef')).trim() || undefined,
      });
      toast(`Calibration recorded. Next due ${t.calibrationDueOn ? formatDay(t.calibrationDueOn) : ''}`);
      setOpen(false);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Panel className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold">Calibration</h2>
        {canRecord && !open && (
          <Button variant="quiet" onClick={() => setOpen(true)}>
            Record calibration
          </Button>
        )}
      </div>
      <p className="mt-1 text-muted">
        Every {tool.calibrationIntervalDays} days.{' '}
        {tool.calibrationDueOn && `Next due ${formatDay(tool.calibrationDueOn)}.`}
      </p>

      {open && canRecord && (
        <form onSubmit={submit} className="mt-4 grid gap-4 rounded-md bg-board p-4 sm:grid-cols-2">
          <Field label="Calibration date" htmlFor="calibratedOn">
            <Input id="calibratedOn" name="calibratedOn" type="date" max={todayIso()} defaultValue={todayIso()} required />
          </Field>
          <Field label="Calibrated by" htmlFor="performedBy">
            <Input id="performedBy" name="performedBy" required maxLength={120} placeholder="External Calibration Lab" />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Certificate number (optional)" htmlFor="certificateRef">
              <Input id="certificateRef" name="certificateRef" maxLength={120} placeholder="CAL-2026-0042" />
            </Field>
          </div>
          <div className="flex flex-col gap-3 sm:col-span-2">
            <ErrorNote>{error}</ErrorNote>
            <div className="flex gap-2">
              <Button type="submit" busy={record.isPending}>
                Save calibration
              </Button>
              <Button type="button" variant="quiet" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </form>
      )}

      {tool.calibrations.length > 0 ? (
        <ol className="mt-4 divide-y divide-line border-t border-line">
          {tool.calibrations.map((c) => (
            <li key={c.id} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-3 text-sm">
              <span>
                <span className="font-semibold">{formatDay(c.calibratedOn)}</span> by {c.performedBy}
              </span>
              <span className="text-muted">
                {c.certificateRef ? `Cert ${c.certificateRef}, ` : ''}valid to {formatDay(c.dueOn)}
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

function ManagePanel({ tool }: { tool: ToolDetail }) {
  const update = useUpdateToolStatus();
  const set = async (status: 'quarantined' | 'retired' | 'available', msg: string) => {
    try {
      await update.mutateAsync({ id: tool.id, status });
      toast(msg);
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };
  return (
    <div className="flex flex-wrap gap-2 border-t border-line pt-5">
      <Link
        href={`/labels?ids=${tool.id}`}
        className="inline-flex min-h-11 items-center gap-2 rounded-md px-4 font-semibold ring-1 ring-inset ring-line hover:bg-panel"
      >
        <QrCode className="size-4" aria-hidden /> Print QR label
      </Link>
      {tool.status === 'available' && (
        <Button variant="quiet" onClick={() => set('quarantined', `${tool.assetTag} quarantined`)}>
          Quarantine
        </Button>
      )}
      {tool.status !== 'checked_out' && tool.status !== 'retired' && (
        <Button variant="quiet" onClick={() => set('retired', `${tool.assetTag} retired`)}>
          Retire
        </Button>
      )}
      {tool.status === 'retired' && (
        <Button variant="quiet" onClick={() => set('available', `${tool.assetTag} back in service`)}>
          Return to service
        </Button>
      )}
    </div>
  );
}
