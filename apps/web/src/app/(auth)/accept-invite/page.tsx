'use client';

import { useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, ErrorNote, Field, Input } from '@/components/ui';
import { registerPasskey } from '@/lib/passkey';
import { meKey } from '@/lib/session';

export default function AcceptInvitePage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const readOnce = useRef(false);

  useEffect(() => {
    if (readOnce.current) return;
    readOnce.current = true;
    // The token lives in the URL fragment, which browsers never send to servers.
    const t = new URLSearchParams(window.location.hash.slice(1)).get('token');
    setToken(t);
    // Remove it from the address bar and history once read.
    if (t) history.replaceState(null, '', window.location.pathname);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError('');
    try {
      const user = await registerPasskey(token, name.trim());
      qc.setQueryData(meKey, user);
      router.replace('/');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (token === undefined) return null;

  if (!token) {
    return (
      <>
        <h1 className="text-[2.4rem] font-semibold">Invite link needed</h1>
        <p className="mt-2 text-muted">
          Open the full invite link your admin sent you. If it has expired, ask them for a new one.
        </p>
      </>
    );
  }

  return (
    <>
      <h1 className="text-[2.4rem] font-semibold">Set up your passkey</h1>
      <p className="mt-2 text-muted">
        Your passkey stays on this device. You&apos;ll sign in with your fingerprint, face or screen-lock PIN.
      </p>
      <form onSubmit={submit} className="mt-8 flex flex-col gap-5">
        <Field label="Your name" htmlFor="name" hint="Shown to the crib when you have a tool out.">
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            required
            maxLength={80}
            placeholder="e.g. Asha Verma"
          />
        </Field>
        <Button type="submit" busy={busy} disabled={!name.trim()} className="min-h-13 text-lg">
          <KeyRound className="size-5" aria-hidden />
          Create passkey and sign in
        </Button>
        <ErrorNote>{error}</ErrorNote>
      </form>
    </>
  );
}
