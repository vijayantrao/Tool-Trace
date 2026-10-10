import { WifiOff } from 'lucide-react';

export const metadata = { title: 'Offline' };

export default function OfflinePage() {
  return (
    <main className="pegboard grid min-h-dvh place-items-center p-6">
      <div className="max-w-sm rounded-xl border border-line bg-panel p-8 text-center">
        <WifiOff className="mx-auto size-10 text-muted" aria-hidden />
        <h1 className="mt-4 text-3xl font-semibold">You&apos;re offline</h1>
        <p className="mt-2 text-muted">
          ToolTrace needs a connection to check tools in and out, so the board always shows the truth. Reconnect and reload.
        </p>
      </div>
    </main>
  );
}
