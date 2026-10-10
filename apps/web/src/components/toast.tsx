'use client';

import { CheckCircle2, CircleAlert, Radio } from 'lucide-react';
import { useEffect, useState } from 'react';

type Toast = { id: number; text: string; tone: 'ok' | 'error' | 'info' };
type Listener = (t: Toast) => void;

const listeners = new Set<Listener>();
let nextId = 1;

/** Fire-and-forget notifications: toast('Checked out TW-0101'). */
export function toast(text: string, tone: Toast['tone'] = 'ok') {
  const t = { id: nextId++, text, tone };
  listeners.forEach((l) => l(t));
}

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);

  useEffect(() => {
    const onToast: Listener = (t) => {
      setItems((prev) => [...prev.slice(-2), t]);
      setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), 4500);
    };
    listeners.add(onToast);
    return () => {
      listeners.delete(onToast);
    };
  }, []);

  return (
    <div
      aria-live="polite"
      className="no-print pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 px-4 md:bottom-6"
    >
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`pointer-events-auto flex max-w-md items-center gap-2 rounded-lg px-4 py-3 text-sm font-medium shadow-lg ${
            { ok: 'bg-machine text-machine-ink', error: 'bg-signal text-white', info: 'bg-ink text-panel' }[t.tone]
          }`}
        >
          {t.tone === 'ok' ? (
            <CheckCircle2 className="size-4 shrink-0" />
          ) : t.tone === 'info' ? (
            <Radio className="size-4 shrink-0" />
          ) : (
            <CircleAlert className="size-4 shrink-0" />
          )}
          {t.text}
        </div>
      ))}
    </div>
  );
}
