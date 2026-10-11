'use client';

import { FlaskConical } from 'lucide-react';
import { useMeta } from '@/lib/meta';

/** Always visible on the public demo, so nobody mistakes it for a real system or types in real data. */
export function DemoBanner() {
  const { data } = useMeta();
  if (!data?.demo) return null;
  return (
    <p className="no-print mb-6 flex items-start gap-2 rounded-lg border border-line bg-panel px-4 py-2.5 text-sm">
      <FlaskConical className="mt-0.5 size-4 shrink-0 text-machine" aria-hidden />
      <span>
        <span className="font-semibold">Public demo.</span> Everything here is fictional and resets every night, so
        please don&apos;t enter real information.
      </span>
    </p>
  );
}
