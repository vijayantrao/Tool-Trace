import type { KitState } from '@/lib/types';

const states: Record<KitState, [string, string]> = {
  in_crib: ['Complete, in the crib', 'bg-ok-soft text-ink'],
  out: ['Out', 'bg-board text-ink ring-1 ring-inset ring-line'],
  partial: ['Partly out', 'bg-due-soft text-ink'],
  unavailable: ['Not ready: a piece is unavailable', 'bg-signal-soft text-ink'],
  empty: ['No tools yet', 'bg-board text-muted'],
};

export function KitStateBadge({ state }: { state: KitState }) {
  const [label, style] = states[state];
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${style}`}>{label}</span>;
}
