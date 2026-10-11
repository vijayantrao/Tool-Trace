'use client';

import { CloudOff, RefreshCw, TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui';
import { useOffline } from '@/lib/offline';
import { describeItem } from '@/lib/outbox';

/** Connection state and the offline outbox, at the top of every signed-in page. */
export function OfflineBanner() {
  const state = useOffline();
  if (!state) return null;
  const { online, items, syncing, dismiss, syncNow } = state;
  const pending = items.filter((i) => i.state === 'pending');
  const failed = items.filter((i) => i.state === 'failed');
  if (online && items.length === 0) return null;

  const n = pending.length;
  const actions = `${n} ${n === 1 ? 'action' : 'actions'}`;

  return (
    <div className="no-print mb-6 flex flex-col gap-3">
      {(!online || n > 0) && (
        <div
          role="status"
          className={`flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 ${
            online ? 'border-line bg-panel' : 'border-safety bg-due-soft'
          }`}
        >
          {online ? (
            <RefreshCw className={`size-5 shrink-0 ${syncing ? 'animate-spin' : ''}`} aria-hidden />
          ) : (
            <CloudOff className="size-5 shrink-0" aria-hidden />
          )}
          <p className="min-w-0 flex-1">
            {!online ? (
              <>
                <span className="font-semibold">You&apos;re offline.</span>{' '}
                {n > 0
                  ? `${actions} will be sent as soon as you're back online.`
                  : 'Check-outs you make now are saved and sent when you’re back online.'}
              </>
            ) : (
              <>{syncing ? `Sending ${actions}…` : `${actions} waiting to be sent.`}</>
            )}
          </p>
          {online && !syncing && n > 0 && (
            <Button variant="quiet" onClick={() => void syncNow()}>
              Send now
            </Button>
          )}
          {n > 0 && (
            <ul className="w-full text-sm text-muted">
              {pending.map((i) => (
                <li key={i.id}>{describeItem(i)}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {failed.length > 0 && (
        <section aria-labelledby="failed-h" className="rounded-lg border border-signal/40 bg-signal-soft px-4 py-3">
          <h2 id="failed-h" className="flex items-center gap-2 font-semibold">
            <TriangleAlert className="size-5 text-signal" aria-hidden />
            {failed.length === 1 ? 'An offline action couldn’t be completed' : `${failed.length} offline actions couldn’t be completed`}
          </h2>
          <ul className="mt-2 flex flex-col gap-2">
            {failed.map((i) => (
              <li key={i.id} className="flex items-start gap-3">
                <p className="min-w-0 flex-1 text-sm">
                  <span className="font-semibold">{describeItem(i)}:</span> {i.error}
                </p>
                <button
                  onClick={() => void dismiss(i.id)}
                  className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-sm font-semibold hover:bg-black/10"
                  aria-label={`Dismiss: ${describeItem(i)}`}
                >
                  <X className="size-4" aria-hidden /> Dismiss
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
