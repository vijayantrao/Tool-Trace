'use client';

import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Fingerprint, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Button, ErrorNote } from '@/components/ui';
import { api, errorText } from '@/lib/api';
import { useMeta } from '@/lib/meta';
import { signInWithPasskey } from '@/lib/passkey';
import { meKey, useMe } from '@/lib/session';
import type { Me } from '@/lib/types';

function safeNext(): string {
  const next = new URLSearchParams(window.location.search).get('next') ?? '/';
  // Only allow same-site paths, never "//evil.com" or absolute URLs.
  return next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

const PERSONAS = [
  { persona: 'admin', role: 'Admin', name: 'Priya Nair', does: 'Everything: people, stations, the audit trail' },
  { persona: 'storekeeper', role: 'Storekeeper', name: 'Ravi Kumar', does: 'Runs the crib: issues, receives, calibrates' },
  { persona: 'technician', role: 'Technician', name: 'Asha Verma', does: 'Takes tools out on the floor, on a phone' },
  { persona: 'auditor', role: 'Auditor', name: 'Meera Iyer', does: 'Read-only: insights and the audit trail' },
] as const;

/** Free hosting sleeps when idle. Say so, instead of looking broken, if the first answer is slow. */
function WakeUp() {
  const meta = useMeta();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 2500);
    return () => clearTimeout(t);
  }, []);
  if (!meta.isLoading || !slow) return null;
  return (
    <p role="status" className="mb-6 flex items-start gap-2 rounded-lg bg-due-soft px-4 py-3 text-sm">
      <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden />
      <span>
        <span className="font-semibold">Waking up the server.</span> The free hosting sleeps when nobody is using it;
        this takes about a minute, once.
      </span>
    </p>
  );
}

function DemoPersonas({ onSignedIn }: { onSignedIn: (user: Me) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  return (
    <section aria-labelledby="demo-h" className="mb-10">
      <h2 id="demo-h" className="text-2xl font-semibold">
        Try the demo
      </h2>
      <p className="mt-1 text-sm text-muted">
        A public demo with fictional data that resets every night. Pick a role to look around as:
      </p>
      <ul className="mt-4 flex flex-col gap-2">
        {PERSONAS.map((p) => (
          <li key={p.persona}>
            <button
              disabled={busy !== null}
              onClick={async () => {
                setBusy(p.persona);
                setError('');
                try {
                  const { user } = await api<{ user: Me }>('/auth/demo', { body: { persona: p.persona } });
                  onSignedIn(user);
                } catch (e) {
                  setError(errorText(e));
                  setBusy(null);
                }
              }}
              className="flex w-full items-center gap-3 rounded-lg border border-line px-4 py-3 text-left hover:border-machine hover:bg-board disabled:opacity-60"
            >
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">
                  {p.role} <span className="font-normal text-muted">· {p.name}</span>
                </span>
                <span className="block text-sm text-muted">{p.does}</span>
              </span>
              {busy === p.persona ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <ChevronRight className="size-4 text-muted" aria-hidden />
              )}
              <span className="sr-only">Sign in as the demo {p.role.toLowerCase()}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-3">
        <ErrorNote>{error}</ErrorNote>
      </div>
    </section>
  );
}

function Login() {
  const router = useRouter();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const meta = useMeta();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (me) router.replace(safeNext());
  }, [me, router]);

  const signedIn = (user: Me) => {
    qc.setQueryData(meKey, user);
    router.replace(safeNext());
  };

  async function signIn() {
    setBusy(true);
    setError('');
    try {
      signedIn(await signInWithPasskey());
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const demo = meta.data?.demo === true;
  return (
    <>
      <WakeUp />
      {demo && <DemoPersonas onSignedIn={signedIn} />}
      <h1 className={demo ? 'text-2xl font-semibold' : 'text-[2.6rem] font-semibold'}>
        {demo ? 'Have an account? Sign in' : 'Sign in'}
      </h1>
      <p className="mt-2 text-muted">
        Use the passkey on this device: your fingerprint, face, or the PIN you use to unlock it.
      </p>
      <div className="mt-8 flex flex-col gap-4">
        <Button onClick={signIn} busy={busy} className="min-h-13 text-lg" variant={demo ? 'quiet' : 'primary'}>
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
