'use client';

import { CheckCircle2, CircleAlert, Clock } from 'lucide-react';
import { useState } from 'react';
import { toast } from '@/components/toast';
import { Button, Input } from '@/components/ui';
import { errorText } from '@/lib/api';
import { formatDateTime, relative } from '@/lib/format';
import { useAnswerAck } from '@/lib/queries';
import type { AckStatus, PendingAck } from '@/lib/types';

/** One line: has the person confirmed they received it? */
export function AckLine({
  status,
  who,
  respondedAt,
  note,
}: {
  status: AckStatus;
  who: string;
  respondedAt?: string | null;
  note?: string | null;
}) {
  if (status === 'acknowledged') {
    return (
      <p className="flex items-center gap-1.5 text-sm text-ok">
        <CheckCircle2 className="size-4 shrink-0" aria-hidden />
        {who} confirmed receipt{respondedAt ? ` ${relative(respondedAt)}` : ''}.
      </p>
    );
  }
  if (status === 'disputed') {
    return (
      <p className="flex items-start gap-1.5 text-sm font-semibold text-signal">
        <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          {who} says they did not receive it{respondedAt ? ` (${formatDateTime(respondedAt)})` : ''}.{note ? ` “${note}”` : ''}
        </span>
      </p>
    );
  }
  return (
    <p className="flex items-center gap-1.5 text-sm text-muted">
      <Clock className="size-4 shrink-0" aria-hidden />
      Waiting for {who} to confirm they received it.
    </p>
  );
}

/** The two answers: "I have it" or "I didn't get it" (with an optional note). */
export function AckButtons({ id, compact, onDone }: { id: string; compact?: boolean; onDone?: () => void }) {
  const answer = useAnswerAck();
  const [disputing, setDisputing] = useState(false);
  const [note, setNote] = useState('');

  const send = async (a: 'received' | 'not_received') => {
    try {
      await answer.mutateAsync({ id, answer: a, note: note.trim() || undefined });
      toast(a === 'received' ? 'Thanks, confirmed' : 'Reported: the crib will look into it', a === 'received' ? 'ok' : 'info');
      onDone?.();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };

  if (disputing) {
    return (
      <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          aria-label="What happened? (optional)"
          placeholder="What happened? (optional)"
          value={note}
          maxLength={300}
          onChange={(e) => setNote(e.target.value)}
          className="sm:flex-1"
        />
        <div className="flex gap-2">
          <Button variant="danger" busy={answer.isPending} onClick={() => send('not_received')}>
            Report it
          </Button>
          <Button variant="quiet" onClick={() => setDisputing(false)}>
            Back
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button busy={answer.isPending} onClick={() => send('received')} className={compact ? 'min-h-10 px-3' : ''}>
        I have it
      </Button>
      <Button variant="quiet" onClick={() => setDisputing(true)} className={compact ? 'min-h-10 px-3' : ''}>
        I didn&apos;t get it
      </Button>
    </div>
  );
}

/** Home screen: everything issued to me that I still have to confirm. */
export function PendingAcks({ items }: { items: PendingAck[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="to-confirm" className="mb-8">
      <h2 id="to-confirm" className="mb-3 text-xl font-semibold">
        Please confirm what you were issued
      </h2>
      <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border-2 border-safety bg-panel">
        {items.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <span className="min-w-[min(100%,15rem)] flex-1">
              <span className="block font-semibold">{a.summary}</span>
              <span className="text-sm text-muted">
                Issued by {a.requestedByName} {relative(a.createdAt)}
              </span>
            </span>
            <AckButtons id={a.id} compact />
          </li>
        ))}
      </ul>
    </section>
  );
}
