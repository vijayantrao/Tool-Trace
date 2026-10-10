'use client';

import QRCode from 'qrcode';
import { Copy } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { TagEditor } from '@/components/tag-editor';
import { toast } from '@/components/toast';
import { Button, ErrorNote, Field, Input, PageHeader, Panel, Select, Spinner } from '@/components/ui';
import { errorText } from '@/lib/api';
import { formatDateTime, roleLabel } from '@/lib/format';
import { useCreateInvite, useInvites, useRevokeInvite, useUpdateUser, useUsers } from '@/lib/queries';
import { can, useMe } from '@/lib/session';
import type { Role } from '@/lib/types';

const roles: { value: Role; hint: string }[] = [
  { value: 'technician', hint: 'Checks tools out to themselves' },
  { value: 'storekeeper', hint: 'Runs the crib: issues, receives, calibrates' },
  { value: 'auditor', hint: 'Read-only access to everything' },
  { value: 'admin', hint: 'Everything, plus people and invites' },
];

export default function PeoplePage() {
  const { data: me } = useMe();
  const allowed = can.seePeople(me?.role);
  const admin = can.managePeople(me?.role);
  const users = useUsers(allowed);

  if (!allowed) return <ErrorNote>Only admins and auditors can see this page.</ErrorNote>;

  return (
    <>
      <PageHeader title="People" sub="Everyone signs in with a passkey. New people join through a one-time invite link." />
      {admin && <InviteSection />}

      <h2 className="mb-3 mt-8 text-2xl font-semibold">Accounts</h2>
      {users.isLoading ? (
        <Spinner />
      ) : users.isError ? (
        <ErrorNote>{errorText(users.error)}</ErrorNote>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
          {users.data!.map((u) => (
            <UserRow key={u.id} user={u} editable={admin && u.id !== me!.id} canBadge={admin} />
          ))}
        </ul>
      )}
    </>
  );
}

function UserRow({ user, editable, canBadge }: { user: import('@/lib/types').UserRow; editable: boolean; canBadge: boolean }) {
  const update = useUpdateUser();
  const change = async (body: { role?: Role; isActive?: boolean }, msg: string) => {
    try {
      await update.mutateAsync({ id: user.id, ...body });
      toast(msg);
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };

  return (
    <li className={`flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center ${user.isActive ? '' : 'opacity-60'}`}>
      <div className="min-w-0 flex-1">
        <div className="font-semibold">
          {user.displayName}
          {!user.isActive && <span className="ml-2 text-sm font-normal text-signal">Deactivated</span>}
        </div>
        <div className="truncate text-sm text-muted">{user.email}</div>
        <div className="mt-1.5">
          <TagEditor
            label="Badge"
            value={user.badgeUid}
            canEdit={canBadge}
            onSave={(badgeUid) => update.mutateAsync({ id: user.id, badgeUid })}
            savedMessage={(uid) => (uid ? `Badge assigned to ${user.displayName}` : `Badge removed from ${user.displayName}`)}
          />
        </div>
      </div>
      {editable ? (
        <div className="flex gap-2">
          <Select
            aria-label={`Role for ${user.displayName}`}
            value={user.role}
            disabled={update.isPending}
            onChange={(e) => change({ role: e.target.value as Role }, `${user.displayName} is now ${roleLabel[e.target.value as Role]}`)}
            className="w-40"
          >
            {roles.map((r) => (
              <option key={r.value} value={r.value}>
                {roleLabel[r.value]}
              </option>
            ))}
          </Select>
          <Button
            variant={user.isActive ? 'quiet' : 'primary'}
            disabled={update.isPending}
            onClick={() =>
              change(
                { isActive: !user.isActive },
                user.isActive ? `${user.displayName} deactivated and signed out` : `${user.displayName} reactivated`,
              )
            }
          >
            {user.isActive ? 'Deactivate' : 'Reactivate'}
          </Button>
        </div>
      ) : (
        <span className="text-sm font-semibold text-muted">{roleLabel[user.role]}</span>
      )}
    </li>
  );
}

function InviteSection() {
  const create = useCreateInvite();
  const invites = useInvites(true);
  const revoke = useRevokeInvite();
  const [role, setRole] = useState<Role>('technician');
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ email: string; url: string } | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const form = e.currentTarget;
    const email = String(new FormData(form).get('email')).trim();
    try {
      const { invite } = await create.mutateAsync({ email, role });
      setCreated({ email: invite.email, url: invite.inviteUrl });
      form.reset();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Panel className="p-5">
      <h2 className="text-2xl font-semibold">Invite someone</h2>
      <form onSubmit={submit} className="mt-4 grid gap-4 sm:grid-cols-[1fr_14rem_auto] sm:items-end">
        <Field label="Email" htmlFor="email">
          <Input id="email" name="email" type="email" required autoComplete="off" placeholder="name@company.com" />
        </Field>
        <Field label="Role" htmlFor="role">
          <Select id="role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {roles.map((r) => (
              <option key={r.value} value={r.value}>
                {roleLabel[r.value]}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" busy={create.isPending}>
          Create invite
        </Button>
      </form>
      <p className="mt-2 text-sm text-muted">{roles.find((r) => r.value === role)!.hint}.</p>
      <div className="mt-3">
        <ErrorNote>{error}</ErrorNote>
      </div>

      {created && <InviteLink email={created.email} url={created.url} />}

      {invites.data && invites.data.length > 0 && (
        <div className="mt-6 border-t border-line pt-4">
          <h3 className="mb-2 font-semibold">Waiting to be accepted</h3>
          <ul className="flex flex-col gap-2">
            {invites.data.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-medium">{i.email}</span>
                <span className="text-muted">
                  {roleLabel[i.role]}, expires {formatDateTime(i.expiresAt)}
                </span>
                <button
                  className="ml-auto font-semibold text-signal underline-offset-2 hover:underline"
                  onClick={async () => {
                    await revoke.mutateAsync(i.id).catch((e) => toast(errorText(e), 'error'));
                    toast(`Invite for ${i.email} revoked`);
                  }}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

/** Shown once: the raw link is never stored, so it can't be shown again later. */
function InviteLink({ email, url }: { email: string; url: string }) {
  const [qr, setQr] = useState('');
  useEffect(() => {
    QRCode.toDataURL(url, { margin: 1, width: 320 }).then(setQr).catch(() => {});
  }, [url]);

  return (
    <div className="mt-5 grid gap-4 rounded-lg border-2 border-machine bg-board p-4 sm:grid-cols-[1fr_auto]">
      <div className="min-w-0">
        <p className="font-semibold">Invite link for {email}</p>
        <p className="mt-1 text-sm text-muted">
          Send this link, or let them scan the code with their phone. It works once and expires in 3 days. It won&apos;t be
          shown again.
        </p>
        <div className="mt-3 flex gap-2">
          <Input readOnly value={url} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} className="text-sm" />
          <Button
            variant="quiet"
            className="bg-panel"
            onClick={async () => {
              await navigator.clipboard.writeText(url);
              toast('Invite link copied');
            }}
          >
            <Copy className="size-4" aria-hidden /> Copy
          </Button>
        </div>
      </div>
      {qr && <img src={qr} alt={`QR code of the invite link for ${email}`} className="size-36 justify-self-center rounded bg-white p-1" />}
    </div>
  );
}
