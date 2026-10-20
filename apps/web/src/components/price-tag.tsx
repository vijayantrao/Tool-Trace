'use client';

import { useMoney } from '@/lib/meta';
import type { AbcClass } from '@/lib/types';

/** Unit price with its A/B/C class. */
export function PriceTag({ price, abcClass }: { price: number | null; abcClass: AbcClass | null }) {
  const money = useMoney();
  if (price === null) return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm ring-1 ring-inset ring-line" title={`Class ${abcClass}`}>
      <span className="font-semibold tabular-nums">{money(price)}</span>
      <ClassBadge abcClass={abcClass} />
    </span>
  );
}

export function ClassBadge({ abcClass }: { abcClass: AbcClass | null }) {
  if (!abcClass) return null;
  return (
    <span className="rounded bg-ink px-1 text-[0.72rem] font-bold leading-4 text-panel" aria-label={`Class ${abcClass}`}>
      {abcClass}
    </span>
  );
}
