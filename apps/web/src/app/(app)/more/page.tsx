'use client';

import Link from 'next/link';
import { ChevronRight, LogOut, QrCode, Users } from 'lucide-react';
import { useSignOut } from '@/components/app-shell';
import { PageHeader } from '@/components/ui';
import { initials, roleLabel } from '@/lib/format';
import { can, useMe } from '@/lib/session';

export default function MorePage() {
  const { data: me } = useMe();
  const signOut = useSignOut();
  if (!me) return null;

  const links = [
    can.manageTools(me.role) && { href: '/labels', label: 'QR labels', icon: QrCode },
    can.seePeople(me.role) && { href: '/people', label: 'People and invites', icon: Users },
  ].filter(Boolean) as { href: string; label: string; icon: typeof QrCode }[];

  return (
    <div className="max-w-md">
      <PageHeader title="Menu" />
      <div className="mb-6 flex items-center gap-3 rounded-lg border border-line bg-panel p-4">
        <span className="grid size-12 place-items-center rounded-full bg-machine font-semibold text-machine-ink">
          {initials(me.displayName)}
        </span>
        <div>
          <div className="text-lg font-semibold">{me.displayName}</div>
          <div className="text-sm text-muted">
            {roleLabel[me.role]}, {me.email}
          </div>
        </div>
      </div>
      {links.length > 0 && (
        <ul className="mb-6 divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
          {links.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="flex min-h-14 items-center gap-3 px-4 hover:bg-board">
                <l.icon className="size-5 text-muted" aria-hidden />
                <span className="flex-1 font-medium">{l.label}</span>
                <ChevronRight className="size-4 text-muted" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
      <button
        onClick={signOut}
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-line bg-panel font-semibold hover:bg-board"
      >
        <LogOut className="size-4" aria-hidden /> Sign out
      </button>
    </div>
  );
}
