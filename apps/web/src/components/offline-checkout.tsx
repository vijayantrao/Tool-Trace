'use client';

import { CloudOff } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DuePicker } from '@/components/due-picker';
import { AssetTag } from '@/components/tool-visuals';
import { Button } from '@/components/ui';
import { newCheckoutItem, type OutboxItem } from '@/lib/outbox';

/**
 * Offline check-out of a scanned tag, to yourself. Nothing is decided on the
 * phone: availability and calibration are checked by the server when it syncs,
 * and if the tool can't be issued then, you are told why.
 */
export function OfflineCheckout({
  tag,
  userId,
  onQueue,
  onCancel,
}: {
  tag: string;
  userId: string;
  onQueue: (item: OutboxItem) => Promise<void>;
  onCancel: () => void;
}) {
  const [hours, setHours] = useState(8);
  const [busy, setBusy] = useState(false);
  const due = useMemo(() => new Date(Date.now() + hours * 3_600_000), [hours]);

  return (
    <section aria-labelledby="offline-co" className="rounded-lg border-2 border-safety bg-panel p-5">
      <h2 id="offline-co" className="flex items-center gap-2 text-2xl font-semibold">
        <CloudOff className="size-6" aria-hidden /> No connection
      </h2>
      <p className="mt-2 flex flex-wrap items-center gap-2">
        Check out <AssetTag tag={tag} /> to yourself now?
      </p>
      <p className="mt-1 text-sm text-muted">
        It&apos;s saved on this phone and sent as soon as you&apos;re back online. The crib&apos;s rules (availability,
        calibration) are checked then.
      </p>
      <div className="mt-4">
        <DuePicker hours={hours} onChange={setHours} due={due} />
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        <Button
          busy={busy}
          onClick={async () => {
            setBusy(true);
            await onQueue(newCheckoutItem(userId, tag, hours));
            setBusy(false);
          }}
        >
          Check out {tag} when back online
        </Button>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
