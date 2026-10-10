'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Fingerprint } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Button, ErrorNote } from '@/components/ui';
import { signInWithPasskey } from '@/lib/passkey';
import { meKey, useMe } from '@/lib/session';

function safeNext(): string {
  const next = new URLSearchParams(window.location.search).get('next') ?? '/';
  // Only allow same-site paths, never "//evil.com" or absolute URLs.
  return next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

function Login() {
  const router = useRouter();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (me) router.replace(safeNext());
  }, [me, router]);

  async function signIn() {
    setBusy(true);
    setError('');
    try {
      const user = await signInWithPasskey();
      qc.setQueryData(meKey, user);
      router.replace(safeNext());
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="text-[2.6rem] font-semibold">Sign in</h1>
      <p className="mt-2 text-muted">
        Use the passkey on this device: your fingerprint, face, or the PIN you use to unlock it.
      </p>
      <div className="mt-8 flex flex-col gap-4">
        <Button onClick={signIn} busy={busy} className="min-h-13 text-lg">
          <Fingerprint className="size-5" aria-hidden />
          Sign in with passkey
        </Button>
        <ErrorNote>{error}</ErrorNote>
      </div>
      <p className="mt-10 border-t border-line pt-6 text-sm text-muted">
        New to ToolTrace? Ask your admin for an invite link. There are no passwords to remember.
      </p>
    </>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}
