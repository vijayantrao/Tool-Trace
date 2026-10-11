import { WifiOff } from 'lucide-react';
import { OfflineOutbox } from '@/components/offline-outbox';

export const metadata = { title: 'Offline' };

export default function OfflinePage() {
  return (
    <main className="pegboard grid min-h-dvh place-items-center p-6">
      <div className="w-full max-w-sm rounded-xl border border-line bg-panel p-8 text-center">
        <WifiOff className="mx-auto size-10 text-muted" aria-hidden />
        <h1 className="mt-4 text-3xl font-semibold">You&apos;re offline</h1>
        <p className="mt-2 text-muted">
          The board needs a connection to show the truth. Check-outs you make here are saved on this phone and sent as
          soon as you&apos;re back online.
        </p>
        <OfflineOutbox />
      </div>
    </main>
  );
}
