import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="pegboard grid min-h-dvh place-items-center p-6">
      <div className="max-w-sm rounded-xl border-2 border-dashed border-muted/45 bg-panel/80 p-8 text-center">
        <h1 className="text-3xl font-semibold">Nothing hangs here</h1>
        <p className="mt-2 text-muted">This page doesn&apos;t exist. It may have moved, or the link is wrong.</p>
        <Link href="/" className="mt-6 inline-block font-semibold text-machine underline underline-offset-4">
          Back to the board
        </Link>
      </div>
    </main>
  );
}
