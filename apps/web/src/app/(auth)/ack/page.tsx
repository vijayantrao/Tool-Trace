'use client';

import { CheckCircle2, CircleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, ErrorNote, Input, Spinner } from '@/components/ui';
import { api, errorText } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

interface Info {
  summary: string;
  issuedBy: string;
  issuedTo: string;
  issuedAt: string;
}

/** Opened from the email "Confirm, or report a problem". Works without signing in, once. */
export default function AckPage() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState('');
  const [disputing, setDisputing] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState<'acknowledged' | 'disputed' | null>(null);
  const readOnce = useRef(false);

  useEffect(() => {
    if (readOnce.current) return;
    readOnce.current = true;
    const t = new URLSearchParams(window.location.hash.slice(1)).get('token');
    setToken(t);
    if (!t) return;
    history.replaceState(null, '', window.location.pathname);
    api<Info>('/ack/info', { body: { token: t } })
      .then(setInfo)
      .catch((err) => setError(errorText(err)));
  }, []);

  const send = async (answer: 'received' | 'not_received') => {
    if (!token) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ status: 'acknowledged' | 'disputed' }>('/ack/answer', { body: { token, answer, note: note.trim() || undefined } });
      setAnswered(r.status);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (token === undefined) return null;
  if (!token) {
    return (
      <>
        <h1 className="text-[2.2rem] font-semibold">Link needed</h1>
        <p className="mt-2 text-muted">Open the full link from your email.</p>
      </>
    );
  }
  if (answered) {
    return (
      <div className="flex flex-col gap-3">
        {answered === 'acknowledged' ? <CheckCircle2 className="size-10 text-ok" aria-hidden /> : <CircleAlert className="size-10 text-signal" aria-hidden />}
        <h1 className="text-[2.2rem] font-semibold">{answered === 'acknowledged' ? 'Thanks, confirmed' : 'Reported'}</h1>
        <p className="text-muted">
          {answered === 'acknowledged' ? 'You can close this page.' : 'The crib has been told and will look into it. You can close this page.'}
        </p>
      </div>
    );
  }
  if (!info) return error ? <ErrorNote>{error}</ErrorNote> : <Spinner />;

  return (
    <>
      <h1 className="text-[2.2rem] font-semibold leading-tight">Did you receive it?</h1>
      <p className="mt-3 text-lg">
        {info.issuedBy} issued <span className="font-semibold">{info.summary}</span> to {info.issuedTo}.
      </p>
      <p className="text-sm text-muted">{formatDateTime(info.issuedAt)}</p>
      <div className="mt-6 flex flex-col gap-3">
        {disputing ? (
          <>
            <Input aria-label="What happened? (optional)" placeholder="What happened? (optional)" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
            <Button variant="danger" busy={busy} onClick={() => send('not_received')}>
              I did not receive it
            </Button>
            <Button variant="quiet" onClick={() => setDisputing(false)}>
              Back
            </Button>
          </>
        ) : (
          <>
            <Button busy={busy} onClick={() => send('received')}>
              Yes, I have it
            </Button>
            <Button variant="quiet" onClick={() => setDisputing(true)}>
              No, I didn&apos;t get it
            </Button>
          </>
        )}
        <ErrorNote>{error}</ErrorNote>
      </div>
    </>
  );
}
