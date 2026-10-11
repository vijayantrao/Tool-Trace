'use client';

import { formatDateTime } from '@/lib/format';

export const QUICK_DUE = [
  { label: 'End of shift', hours: 8 },
  { label: 'Tomorrow', hours: 24 },
  { label: '3 days', hours: 72 },
  { label: '1 week', hours: 168 },
];

export function DuePicker({ hours, onChange, due }: { hours: number; onChange: (h: number) => void; due: Date }) {
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-semibold">Due back</legend>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {QUICK_DUE.map((q) => (
          <button
            type="button"
            key={q.hours}
            onClick={() => onChange(q.hours)}
            aria-pressed={hours === q.hours}
            className={`min-h-11 rounded-md px-3 text-sm font-semibold ${
              hours === q.hours ? 'bg-ink text-panel' : 'ring-1 ring-inset ring-line hover:ring-ink/40'
            }`}
          >
            {q.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-sm text-muted">Due {formatDateTime(due.toISOString())}</p>
    </fieldset>
  );
}
