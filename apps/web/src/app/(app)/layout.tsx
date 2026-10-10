'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { Spinner } from '@/components/ui';
import { LiveFloorProvider } from '@/lib/live';
import { useMe } from '@/lib/session';

export default function SignedInLayout({ children }: { children: ReactNode }) {
  const { data: me, isLoading, isError } = useMe();
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    if (!isLoading && me === null) {
      router.replace(`/login?next=${encodeURIComponent(path)}`);
    }
  }, [isLoading, me, path, router]);

  if (isError) {
    return (
      <div className="grid min-h-dvh place-items-center p-6 text-center">
        <p>
          The server isn&apos;t responding. Check that the API is running, then{' '}
          <button className="font-semibold underline" onClick={() => location.reload()}>
            reload
          </button>
          .
        </p>
      </div>
    );
  }
  if (!me) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner label="Checking your sign-in" />
      </div>
    );
  }
  return (
    <LiveFloorProvider meId={me.id}>
      <AppShell me={me}>{children}</AppShell>
    </LiveFloorProvider>
  );
}
