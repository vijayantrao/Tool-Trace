'use client';

import { Copy, Link2, Link2Off, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from '@/components/toast';
import { Button, ErrorNote, Field, Input, PageHeader, Panel, Select, Spinner } from '@/components/ui';
import { errorText } from '@/lib/api';
import { formatDateTime, formatDay, formatUid, roleLabel } from '@/lib/format';
import { useAudit, useVerifyAudit } from '@/lib/queries';
import { can, useMe } from '@/lib/session';
import type { AuditEntry, AuditVerification, Role } from '@/lib/types';

const FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'Everything' },
  { value: 'auth.', label: 'Sign-ins' },
  { value: 'tool.', label: 'Tools and check-outs' },
  { value: 'calibration.', label: 'Calibrations' },
  { value: 'user.', label: 'People' },
  { value: 'invite.', label: 'Invites' },
  { value: 'station.', label: 'Stations' },
  { value: 'location.', label: 'Locations' },
];

export default function AuditPage() {
  const { data: me } = useMe();
  const allowed = can.seeAudit(me?.role);
  const [action, setAction] = useState('');
  const audit = useAudit(action, allowed);

  if (!allowed) return <ErrorNote>Only admins and auditors can see the audit trail.</ErrorNote>;
  const entries = audit.data?.pages.flat() ?? [];

  return (
    <>
      <PageHeader
        title="Audit trail"
        sub="Every change, sign-in and rejected station message. Each entry is sealed with a SHA-256 hash of the one before, so nothing can be quietly edited or removed."
      />

      <IntegrityCheck />

      <section aria-labelledby="entries-h">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <h2 id="entries-h" className="text-2xl font-semibold">
            Entries
          </h2>
          <div className="w-full sm:w-64">
            <Field label="Show" htmlFor="audit-filter">
              <Select id="audit-filter" value={action} onChange={(e) => setAction(e.target.value)}>
                {FILTERS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>

        {audit.isLoading ? (
          <Spinner />
        ) : audit.isError ? (
          <ErrorNote>{errorText(audit.error)}</ErrorNote>
        ) : entries.length === 0 ? (
          <p className="rounded-lg border border-line bg-panel px-4 py-8 text-center text-muted">Nothing recorded yet.</p>
        ) : (
          <ol className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
            {entries.map((e) => (
              <EntryRow key={e.id} e={e} />
            ))}
          </ol>
        )}
        {audit.hasNextPage && (
          <Button variant="quiet" className="mt-4" busy={audit.isFetchingNextPage} onClick={() => audit.fetchNextPage()}>
            Show older entries
          </Button>
        )}
      </section>
    </>
  );
}

/* ------------------------------------------------------------------------ */

const PROBLEM_TEXT: Record<NonNullable<AuditVerification['firstProblem']>['reason'], string> = {
  missing_entries: 'entries are missing (deleted) from this point',
  broken_link: 'the link to the previous entry is broken',
  content_changed: 'this entry was changed after it was written',
};

function parseAnchor(text: string): { id: number; hash: string } | null {
  const m = /^#?(\d+):([0-9a-f]{64})$/i.exec(text.trim());
  return m ? { id: Number(m[1]), hash: m[2]!.toLowerCase() } : null;
}

function IntegrityCheck() {
  const verify = useVerifyAudit();
  const [anchorText, setAnchorText] = useState('');
  const [error, setError] = useState('');
  const result = verify.data;

  async function run(e: FormEvent) {
    e.preventDefault();
    setError('');
    const anchor = anchorText.trim() ? parseAnchor(anchorText) : undefined;
    if (anchor === null) {
      setError('An anchor looks like 1234:followed-by-64-hex-characters. Paste the one you copied earlier.');
      return;
    }
    await verify.mutateAsync(anchor).catch((err) => setError(errorText(err)));
  }

  const anchorOf = (r: AuditVerification) => (r.head ? `${r.head.id}:${r.head.hash}` : '');

  return (
    <Panel className="mb-8 p-5">
      <h2 className="text-2xl font-semibold">Integrity check</h2>
      <p className="mt-1 text-muted">
        Recomputes every hash from the first entry. To catch someone rewriting the whole chain, keep the anchor from a
        previous check somewhere outside ToolTrace (an email, a printed report) and paste it here.
      </p>
      <form onSubmit={run} className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <Field label="Saved anchor (optional)" htmlFor="audit-anchor">
          <Input
            id="audit-anchor"
            value={anchorText}
            onChange={(e) => setAnchorText(e.target.value)}
            placeholder="1234:9f2c…"
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-sm"
          />
        </Field>
        <Button type="submit" busy={verify.isPending}>
          Verify integrity
        </Button>
      </form>
      <div className="mt-3">
        <ErrorNote>{error}</ErrorNote>
      </div>

      {result && (
        <div
          role="status"
          className={`mt-4 rounded-md border px-4 py-3 ${result.ok ? 'border-ok/40 bg-ok-soft' : 'border-signal/40 bg-signal-soft'}`}
        >
          <p className="flex items-center gap-2 font-semibold">
            {result.ok ? (
              <>
                <Link2 className="size-5 text-ok" aria-hidden /> Chain intact: {result.checked} entries checked
              </>
            ) : (
              <>
                <Link2Off className="size-5 text-signal" aria-hidden /> Tampering detected
              </>
            )}
          </p>
          {result.firstProblem && (
            <p className="mt-1">
              At entry #{result.firstProblem.id}: {PROBLEM_TEXT[result.firstProblem.reason]}.
            </p>
          )}
          {result.anchorMatches === false && !result.firstProblem && (
            <p className="mt-1">
              The chain is consistent but does not contain your anchor: the whole trail was rewritten after the anchor
              was taken.
            </p>
          )}
          {result.anchorMatches === true && <p className="mt-1">Your saved anchor matches.</p>}
          {result.ok && result.head && (
            <div className="mt-3">
              <p className="text-sm text-muted">New anchor (save it outside ToolTrace):</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <code aria-label="Anchor" className="min-w-0 break-all rounded bg-panel px-2 py-1 text-sm">
                  {anchorOf(result)}
                </code>
                <Button
                  variant="quiet"
                  className="bg-panel"
                  onClick={async () => {
                    await navigator.clipboard.writeText(anchorOf(result));
                    toast('Anchor copied');
                  }}
                >
                  <Copy className="size-4" aria-hidden /> Copy
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------------ */

const SECURITY_ACTIONS = new Set(['auth.sign_in_failed', 'station.message_rejected']);

const FAILED_SIGN_IN: Record<string, string> = {
  unknown_credential: 'unknown passkey',
  account_deactivated: 'account deactivated',
  user_handle_mismatch: 'passkey does not belong to this account',
  signature_invalid: 'invalid signature',
};

const REJECTED: Record<string, string> = {
  bad_signature: 'forged or altered message rejected',
  replay: 'replayed message rejected',
  stale_clock: 'message with a wrong clock rejected',
  malformed: 'unreadable message rejected',
  station_inactive: 'message from a switched-off station ignored',
};

const str = (v: unknown) => (v === null || v === undefined || v === '' ? '' : String(v));

/** "role: Technician → Storekeeper; badge AA:BB:CC:01 assigned" */
function describeChanges(changes: unknown): string {
  if (!changes || typeof changes !== 'object') return '';
  return Object.entries(changes as Record<string, [unknown, unknown]>)
    .map(([field, [from, to]]) => {
      switch (field) {
        case 'role':
          return `role ${roleLabel[from as Role] ?? str(from)} → ${roleLabel[to as Role] ?? str(to)}`;
        case 'is_active':
          return to ? 'reactivated' : 'deactivated';
        case 'badge_uid':
          return to ? `badge ${formatUid(str(to))} assigned` : 'badge removed';
        case 'rfid_uid':
          return to ? `RFID tag ${formatUid(str(to))} assigned` : 'RFID tag removed';
        case 'display_name':
        case 'name':
          return `renamed from “${str(from)}” to “${str(to)}”`;
        case 'status':
          return `status ${str(from)} → ${str(to)}`;
        case 'home_location_id':
          return 'home location changed';
        case 'category':
          return `category ${str(from)} → ${str(to)}`;
        default:
          return `${field} changed`;
      }
    })
    .join('; ');
}

function describe(e: AuditEntry): string {
  const d = e.details;
  const subject = e.entityName ?? 'Unknown';
  switch (e.action) {
    case 'user.registered':
      return `${str(d.displayName)} joined as ${roleLabel[d.role as Role] ?? str(d.role)}`;
    case 'user.updated':
      return `${subject}: ${describeChanges(d.changes)}`;
    case 'auth.signed_in':
      return `${subject} signed in`;
    case 'auth.sign_in_failed':
      return `Failed sign-in${e.entityName ? ` as ${e.entityName}` : ''}: ${FAILED_SIGN_IN[str(d.reason)] ?? str(d.reason)}`;
    case 'invite.created':
      return `Invited ${str(d.email)} as ${roleLabel[d.role as Role] ?? str(d.role)}`;
    case 'invite.revoked':
      return `Revoked the invite for ${str(d.email)}`;
    case 'location.created':
      return `Added location ${str(d.name)}`;
    case 'tool.created':
      return `Added tool ${str(d.assetTag)} ${str(d.name)}`;
    case 'tool.updated':
      return `${subject}: ${describeChanges(d.changes)}`;
    case 'calibration.recorded':
      return `Calibration recorded for ${subject}${d.dueOn ? `, next due ${formatDay(str(d.dueOn))}` : ''}`;
    case 'tool.checked_out':
      return `${subject} checked out`;
    case 'tool.returned':
      return `${subject} returned${d.condition && d.condition !== 'ok' ? ` (${str(d.condition).replace('_', ' ')})` : ''}`;
    case 'station.created':
      return `Added station ${str(d.name)}`;
    case 'station.key_rotated':
      return `New key (version ${str(d.keyVersion)}) issued for ${subject}`;
    case 'station.updated':
      return `${subject}: ${describeChanges(d.changes)}`;
    case 'station.message_rejected':
      return `${subject}: ${REJECTED[str(d.code)] ?? str(d.code)}`;
    default:
      return e.action;
  }
}

function actorText(e: AuditEntry): string {
  if (e.actorName && e.stationName) return `${e.actorName} at ${e.stationName}`;
  if (e.actorName) return e.actorName;
  if (e.stationName) return e.stationName;
  return e.action.startsWith('auth.') ? 'Not signed in' : 'System';
}

function EntryRow({ e }: { e: AuditEntry }) {
  const security = SECURITY_ACTIONS.has(e.action);
  return (
    <li className="flex gap-3 px-4 py-3 text-sm">
      {security ? (
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-signal" aria-label="Security event" />
      ) : (
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p className={security ? 'font-semibold text-signal' : 'font-medium'}>{describe(e)}</p>
        <p className="text-muted">
          {actorText(e)}, {formatDateTime(e.at)}
          {e.actorIp ? `, from ${e.actorIp}` : ''}
        </p>
        <details className="mt-1">
          <summary className="cursor-pointer text-muted hover:text-ink">
            #{e.id} <span className="font-mono">{e.action}</span>
          </summary>
          <dl className="mt-2 grid gap-x-4 gap-y-1 rounded-md bg-board p-3 sm:grid-cols-[auto_1fr]">
            <dt className="font-semibold">Hash</dt>
            <dd className="break-all font-mono">{e.hash}</dd>
            <dt className="font-semibold">Details</dt>
            <dd>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono">
                {JSON.stringify(e.details, null, 2)}
              </pre>
            </dd>
          </dl>
        </details>
      </div>
    </li>
  );
}
