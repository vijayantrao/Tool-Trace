'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftRight,
  FileClock,
  LayoutGrid,
  LogOut,
  Menu,
  QrCode,
  RadioTower,
  ScanLine,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { initials, roleLabel } from '@/lib/format';
import { LiveBadge } from '@/lib/live';
import { can } from '@/lib/session';
import type { Me } from '@/lib/types';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  show?: (m: Me) => boolean;
}

const nav: NavItem[] = [
  { href: '/', label: 'Board', icon: LayoutGrid },
  { href: '/tools', label: 'Tools', icon: Wrench },
  { href: '/scan', label: 'Scan', icon: ScanLine },
  { href: '/checkouts', label: 'Checkouts', icon: ArrowLeftRight },
  { href: '/labels', label: 'QR labels', icon: QrCode, show: (m) => can.manageTools(m.role) },
  { href: '/stations', label: 'Stations', icon: RadioTower, show: (m) => can.seeStations(m.role) },
  { href: '/people', label: 'People', icon: Users, show: (m) => can.seePeople(m.role) },
  { href: '/audit', label: 'Audit trail', icon: FileClock, show: (m) => can.seeAudit(m.role) },
];

const isActive = (path: string, href: string) => (href === '/' ? path === '/' : path.startsWith(href));

export function useSignOut() {
  const router = useRouter();
  const qc = useQueryClient();
  return async () => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    qc.clear();
    router.replace('/login');
  };
}

export function AppShell({ me, children }: { me: Me; children: ReactNode }) {
  const path = usePathname();
  const signOut = useSignOut();
  const items = nav.filter((n) => !n.show || n.show(me));

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[15rem_1fr]">
      {/* Desktop rail */}
      <aside className="no-print sticky top-0 hidden h-dvh flex-col bg-machine text-machine-ink md:flex">
        <Link href="/" className="px-6 pb-6 pt-7">
          <Wordmark />
        </Link>
        <nav aria-label="Main" className="flex flex-1 flex-col gap-1 px-3">
          {items.map((n) => {
            const active = isActive(path, n.href);
            const scan = n.href === '/scan';
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-3 rounded-md px-3 py-2.5 font-medium transition-colors ${
                  scan
                    ? 'my-2 bg-safety text-safety-ink hover:brightness-105'
                    : active
                      ? 'bg-black/20'
                      : 'hover:bg-black/10'
                }`}
              >
                <n.icon className="size-5" aria-hidden />
                {scan ? 'Scan a tool' : n.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-white/15 p-4">
          <div className="mb-3">
            <LiveBadge />
          </div>
          <div className="mb-3 flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-full bg-black/25 text-sm font-semibold">
              {initials(me.displayName)}
            </span>
            <div className="min-w-0 leading-tight">
              <div className="truncate font-semibold">{me.displayName}</div>
              <div className="text-sm opacity-75">{roleLabel[me.role]}</div>
            </div>
          </div>
          <button
            onClick={signOut}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm opacity-85 hover:bg-black/15 hover:opacity-100"
          >
            <LogOut className="size-4" aria-hidden /> Sign out
          </button>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="no-print sticky top-0 z-30 flex items-center justify-between bg-machine px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-machine-ink md:hidden">
        <Link href="/">
          <Wordmark small />
        </Link>
        <span className="ml-auto mr-3">
          <LiveBadge />
        </span>
        <Link
          href="/more"
          className="grid size-10 place-items-center rounded-full bg-black/20 text-sm font-semibold"
          aria-label="Menu"
        >
          {initials(me.displayName)}
        </Link>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 pb-32 pt-6 md:px-10 md:pb-16 md:pt-10">{children}</main>

      {/* Mobile bottom bar, thumb-reachable, with the scan button in the middle */}
      <nav
        aria-label="Main"
        className="no-print fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 items-end border-t border-line bg-panel px-1 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1 md:hidden"
      >
        {[nav[0]!, nav[1]!, nav[2]!, nav[3]!].map((n) => {
          const active = isActive(path, n.href);
          if (n.href === '/scan') {
            return (
              <Link key={n.href} href={n.href} className="flex flex-col items-center gap-1 pb-1" aria-label="Scan a tool">
                <span className="-mt-7 grid size-16 place-items-center rounded-full border-4 border-panel bg-safety text-safety-ink shadow-md">
                  <ScanLine className="size-7" aria-hidden />
                </span>
                <span className="text-[0.72rem] font-semibold">Scan</span>
              </Link>
            );
          }
          return (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active ? 'page' : undefined}
              className={`flex flex-col items-center gap-1 rounded-md py-2 text-[0.72rem] font-semibold ${
                active ? 'text-machine' : 'text-muted'
              }`}
            >
              <n.icon className="size-6" aria-hidden />
              {n.label}
            </Link>
          );
        })}
        <Link
          href="/more"
          aria-current={isActive(path, '/more') ? 'page' : undefined}
          className={`flex flex-col items-center gap-1 rounded-md py-2 text-[0.72rem] font-semibold ${
            isActive(path, '/more') ? 'text-machine' : 'text-muted'
          }`}
        >
          <Menu className="size-6" aria-hidden />
          More
        </Link>
      </nav>
    </div>
  );
}

export function Wordmark({ small }: { small?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <svg viewBox="0 0 32 32" className={small ? 'size-7' : 'size-8'} aria-hidden>
        <rect x="2" y="7" width="28" height="18" rx="3" fill="none" stroke="currentColor" strokeWidth="2.2" />
        <circle cx="7.5" cy="16" r="1.8" fill="currentColor" />
        <circle cx="24.5" cy="16" r="1.8" fill="currentColor" />
        <path d="M12 12h8M16 12v9" stroke="var(--safety)" strokeWidth="2.6" strokeLinecap="round" />
      </svg>
      <span className={`font-display font-bold tracking-wide ${small ? 'text-[1.45rem]' : 'text-[1.7rem]'}`}>
        ToolTrace
      </span>
    </span>
  );
}
