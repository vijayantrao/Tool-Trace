'use client';

/**
 * Small, single-series bar charts in the app's own colours: one hue (machine green),
 * thin rounded bars anchored to the baseline, a hover tooltip on every bar, and the
 * same numbers as a table for screen readers and anyone who prefers one.
 */
export interface Bar {
  key: string;
  label: string;
  value: number;
  /** What the tooltip and table show, e.g. "₹27,000 (2 tools)". */
  detail: string;
}

function Table({ caption, bars }: { caption: string; bars: Bar[] }) {
  return (
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer text-muted hover:text-ink">Show as a table</summary>
      <table className="mt-2 w-full text-left">
        <caption className="sr-only">{caption}</caption>
        <tbody className="divide-y divide-line">
          {bars.map((b) => (
            <tr key={b.key}>
              <th scope="row" className="py-1 pr-4 font-medium">
                {b.label}
              </th>
              <td className="py-1 tabular-nums">{b.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/** Categories down the side, longest bar first: for comparing amounts. */
export function HorizontalBars({ caption, bars }: { caption: string; bars: Bar[] }) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <figure>
      <ul aria-hidden className="flex flex-col gap-2">
        {bars.map((b) => (
          <li key={b.key} className="group relative grid grid-cols-[minmax(6rem,9rem)_1fr] items-center gap-3 text-sm">
            <span className="truncate text-muted" title={b.label}>
              {b.label}
            </span>
            <span className="flex items-center gap-2">
              <span
                className="block h-4 rounded-r-[4px] bg-machine transition-[filter] group-hover:brightness-110"
                style={{ width: `${Math.max(b.value > 0 ? 1.5 : 0, (b.value / max) * 100)}%` }}
              />
              <span className="shrink-0 tabular-nums text-ink">{b.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      <Table caption={caption} bars={bars} />
    </figure>
  );
}

/** Time along the bottom: for counts per week or month. Values show on hover. */
export function ColumnBars({ caption, bars, height = 160 }: { caption: string; bars: Bar[]; height?: number }) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <figure>
      <div aria-hidden className="relative border-b border-line" style={{ height }}>
        <div className="absolute inset-x-0 top-0 border-t border-dashed border-line/70" />
        <span className="absolute -top-2.5 right-0 bg-panel pl-1 text-xs tabular-nums text-muted">{max}</span>
        <div className="flex h-full items-end gap-[2px]">
          {bars.map((b) => (
            <div key={b.key} className="group relative flex h-full flex-1 items-end justify-center">
              {/* The hit target is the whole column, bigger than the bar. */}
              <div
                className="w-full max-w-10 rounded-t-[4px] bg-machine transition-[filter] group-hover:brightness-110"
                style={{ height: `${(b.value / max) * 100}%`, minHeight: b.value > 0 ? 3 : 0 }}
              />
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-xs text-panel shadow group-hover:block">
                <span className="font-semibold">{b.label}</span>: {b.detail}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div aria-hidden className="mt-1 flex gap-[2px] text-[0.7rem] text-muted">
        {bars.map((b, i) => (
          <span key={b.key} className="flex-1 truncate text-center">
            {bars.length > 8 && i % 2 === 1 ? '' : b.label}
          </span>
        ))}
      </div>
      <Table caption={caption} bars={bars} />
    </figure>
  );
}
