'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell, Mail, MailX } from 'lucide-react';
import { toast } from '@/components/toast';
import { Button, ErrorNote, PageHeader, Panel, Spinner } from '@/components/ui';
import { errorText } from '@/lib/api';
import { formatDateTime, relative } from '@/lib/format';
import { useMeta } from '@/lib/meta';
import { useEmailDelivery, useEmailPreference, useMarkRead, useNotifications } from '@/lib/queries';
import { useMe } from '@/lib/session';
import type { AppNotification } from '@/lib/types';

export default function NotificationsPage() {
  const { data: me } = useMe();
  const { data, isLoading, isError, error } = useNotifications();
  const mark = useMarkRead();
  const router = useRouter();

  if (isLoading) return <Spinner />;
  if (isError || !data) return <ErrorNote>{errorText(error)}</ErrorNote>;

  const open = async (n: AppNotification) => {
    if (!n.readAt) await mark.mutateAsync({ ids: [n.id] }).catch(() => {});
    if (n.link) router.push(n.link);
  };

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Notifications"
        sub={data.unread ? `${data.unread} unread` : 'You are all caught up.'}
        actions={
          data.unread > 0 ? (
            <Button variant="quiet" busy={mark.isPending} onClick={() => mark.mutate({ all: true })}>
              Mark all as read
            </Button>
          ) : undefined
        }
      />

      <EmailSettings email={data.email} isAdmin={me?.role === 'admin'} />

      {data.notifications.length === 0 ? (
        <Panel className="flex flex-col items-center gap-2 px-6 py-14 text-center">
          <Bell className="size-8 text-muted" aria-hidden />
          <p className="text-lg">Nothing yet.</p>
          <p className="text-muted">Reminders about overdue tools, calibration, approvals and things to confirm appear here.</p>
        </Panel>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
          {data.notifications.map((n) => (
            <li key={n.id}>
              <button
                onClick={() => open(n)}
                className={`flex w-full gap-3 px-4 py-3.5 text-left hover:bg-board ${n.readAt ? '' : 'bg-due-soft/40'}`}
              >
                <span
                  className={`mt-2 size-2.5 shrink-0 rounded-full ${n.readAt ? 'bg-transparent' : 'bg-safety'}`}
                  aria-label={n.readAt ? undefined : 'Unread'}
                />
                <span className="min-w-0 flex-1">
                  <span className={`block ${n.readAt ? 'font-medium' : 'font-semibold'}`}>{n.title}</span>
                  {n.body && <span className="mt-0.5 block text-sm text-muted">{n.body}</span>}
                </span>
                <time dateTime={n.createdAt} title={formatDateTime(n.createdAt)} className="shrink-0 text-sm text-muted">
                  {relative(n.createdAt)}
                </time>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmailSettings({ email, isAdmin }: { email: { available: boolean; enabled: boolean; address: string }; isAdmin: boolean }) {
  const pref = useEmailPreference();
  const meta = useMeta();
  const delivery = useEmailDelivery(isAdmin && email.available);

  if (!email.available) {
    return (
      <Panel className="mb-6 flex items-start gap-3 p-4 text-sm">
        <MailX className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />
        <p className="text-muted">
          {meta.data?.demo
            ? 'The public demo never sends email, so these notifications appear here only.'
            : isAdmin
              ? 'Email is not set up on this server yet, so notifications appear here only. Add SMTP_URL and MAIL_FROM to the API to send them by email too.'
              : 'Notifications appear here. Your admin can also turn on email.'}
          {isAdmin && !meta.data?.demo && (
            <>
              {' '}
              <Link href="https://github.com/vijayantrao/Tool-Trace/blob/main/docs/DEPLOY.md#9-optional-email-and-reminders" className="font-semibold text-ink underline">
                How to set up email
              </Link>
            </>
          )}
        </p>
      </Panel>
    );
  }

  return (
    <Panel className="mb-6 p-4">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 size-5 accent-[var(--machine)]"
          checked={email.enabled}
          disabled={pref.isPending}
          onChange={async (e) => {
            try {
              await pref.mutateAsync(e.target.checked);
              toast(e.target.checked ? 'You will get these by email too' : 'Email off: notifications appear here only');
            } catch (err) {
              toast(errorText(err), 'error');
            }
          }}
        />
        <span>
          <span className="flex items-center gap-2 font-semibold">
            <Mail className="size-4" aria-hidden /> Email me as well
          </span>
          <span className="text-sm text-muted">To {email.address}. You can change this at any time.</span>
        </span>
      </label>
      {delivery.data && (
        <p className="mt-3 border-t border-line pt-3 text-sm text-muted">
          Email delivery: {delivery.data.sentLastWeek} sent in the last 7 days, {delivery.data.pending} waiting
          {delivery.data.failed ? (
            <>
              , <span className="font-semibold text-signal">{delivery.data.failed} could not be sent</span>
              {delivery.data.lastError ? ` (last error: ${delivery.data.lastError})` : ''}
            </>
          ) : null}
          .
        </p>
      )}
    </Panel>
  );
}
