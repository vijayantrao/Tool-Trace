import Link from 'next/link';
import { Drill, Gauge, Hammer, Ruler, ScanSearch, Wrench, Zap, type LucideIcon } from 'lucide-react';
import { formatShortDay, relative } from '@/lib/format';
import type { CalibrationState, Tool, ToolStatus } from '@/lib/types';

const categoryIcons: [RegExp, LucideIcon][] = [
  [/torque|wrench|spanner/i, Wrench],
  [/measur|caliper|gauge|meter/i, Ruler],
  [/electr|crimp|multimeter/i, Zap],
  [/inspect|scope|camera/i, ScanSearch],
  [/power|drill|impact|pneumatic/i, Drill],
  [/pressure/i, Gauge],
];

export function toolIcon(category: string): LucideIcon {
  return categoryIcons.find(([re]) => re.test(category))?.[1] ?? Hammer;
}

/**
 * Calibration sticker, like the ones on real gauges: colour says the state,
 * the printed date says when.
 */
export function CalSticker({
  state,
  dueOn,
  size = 'sm',
}: {
  state: CalibrationState;
  dueOn: string | null;
  size?: 'sm' | 'md';
}) {
  if (state === 'not_required') {
    return size === 'md' ? <span className="text-sm text-muted">No calibration needed</span> : null;
  }
  const tone = {
    ok: 'border-ok bg-ok-soft',
    due_soon: 'border-safety bg-due-soft',
    expired: 'border-signal bg-signal-soft',
  }[state];
  const band = { ok: 'bg-ok', due_soon: 'bg-safety', expired: 'bg-signal' }[state];
  const text = {
    ok: `Cal due ${dueOn ? formatShortDay(dueOn) : ''}`,
    due_soon: `Cal due ${dueOn ? formatShortDay(dueOn) : ''}`,
    expired: `Cal expired ${dueOn ? formatShortDay(dueOn) : ''}`,
  }[state];
  return (
    <span
      className={`inline-flex items-stretch overflow-hidden rounded-[3px] border ${tone} ${
        size === 'md' ? 'text-sm' : 'text-[0.78rem]'
      } font-semibold leading-none text-ink`}
      title={state === 'expired' ? 'Locked: cannot be checked out until recalibrated' : undefined}
    >
      <span className={`w-1.5 ${band}`} aria-hidden />
      <span className="px-1.5 py-1">{text}</span>
    </span>
  );
}

/** A hang tag: the cardboard tag tied to a tool at the crib window. */
export function StatusTag({ status }: { status: ToolStatus }) {
  const style = {
    available: 'bg-ok-soft text-ink',
    checked_out: 'bg-board text-ink ring-1 ring-inset ring-line',
    quarantined: 'bg-signal text-white',
    retired: 'bg-line text-muted',
  }[status];
  const label = { available: 'In the crib', checked_out: 'Checked out', quarantined: 'Quarantined', retired: 'Retired' }[
    status
  ];
  return (
    <span
      className={`relative inline-flex items-center py-1 pl-4 pr-2 text-[0.78rem] font-semibold leading-none ${style}`}
      style={{ clipPath: 'polygon(8px 0, 100% 0, 100% 100%, 8px 100%, 0 50%)' }}
    >
      <span className="absolute left-[6px] top-1/2 size-[5px] -translate-y-1/2 rounded-full bg-panel" aria-hidden />
      {label}
    </span>
  );
}

/** Engraved asset-tag plate with rivets. */
export function AssetTag({ tag, size = 'sm' }: { tag: string; size?: 'sm' | 'lg' }) {
  const big = size === 'lg';
  return (
    <span
      className={`tag-plate inline-flex items-center rounded-[4px] border border-line bg-panel text-ink ${
        big ? 'gap-3 px-3 py-1.5 text-2xl' : 'gap-1.5 px-1.5 py-0.5 text-[0.9rem]'
      }`}
    >
      <span className={`rounded-full bg-line ${big ? 'size-2' : 'size-1'}`} aria-hidden />
      {tag}
      <span className={`rounded-full bg-line ${big ? 'size-2' : 'size-1'}`} aria-hidden />
    </span>
  );
}

/**
 * One painted outline on the shadow board. If the tool is home, it hangs there.
 * If it's out, only its dashed outline remains, with who has it.
 */
export function ToolSlot({ tool }: { tool: Tool }) {
  const Icon = toolIcon(tool.category);
  const out = tool.status === 'checked_out';
  const quarantined = tool.status === 'quarantined';
  const locked = tool.calibrationState === 'expired';

  return (
    <Link
      href={`/tools/${tool.id}`}
      className={`group relative flex min-h-[9.5rem] flex-col justify-between rounded-xl border-2 p-3 transition-colors ${
        out ? 'border-dashed border-muted/45 bg-transparent' : 'border-ink/15 bg-panel hover:border-machine'
      }`}
      aria-label={[
        `${tool.assetTag} ${tool.name}`,
        out ? `checked out to ${tool.holderName}${tool.overdue ? ', overdue' : ''}` : quarantined ? 'quarantined' : 'in the crib',
        locked ? 'calibration expired, locked' : tool.calibrationState === 'due_soon' ? 'calibration due soon' : '',
      ]
        .filter(Boolean)
        .join(': ')}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="tag-plate text-[0.95rem] text-ink">{tool.assetTag}</span>
        {(locked || tool.calibrationState === 'due_soon') && (
          <span
            className={`mt-0.5 size-3 shrink-0 rounded-[2px] ${locked ? 'bg-signal' : 'bg-safety'}`}
            title={locked ? 'Calibration expired' : 'Calibration due soon'}
          />
        )}
      </div>

      <Icon
        className={`mx-auto my-1 size-12 ${out ? 'text-muted/60' : quarantined ? 'text-signal' : 'text-ink'}`}
        strokeWidth={out ? 1.25 : 1.6}
        strokeDasharray={out ? '2.5 2.5' : undefined}
        aria-hidden
      />

      <div className="min-h-[2.4rem] text-[0.82rem] leading-tight">
        {out ? (
          <>
            <span className="block truncate font-semibold text-ink">{tool.holderName}</span>
            <span className={tool.overdue ? 'font-semibold text-signal' : 'text-muted'}>
              {tool.overdue ? 'Overdue ' : 'Due '}
              {tool.dueBackAt ? relative(tool.dueBackAt) : ''}
            </span>
          </>
        ) : quarantined ? (
          <span className="font-semibold text-signal">Quarantined</span>
        ) : locked ? (
          <span className="font-semibold text-signal">Locked: cal expired</span>
        ) : (
          <span className="line-clamp-2 text-muted">{tool.name}</span>
        )}
      </div>
    </Link>
  );
}
