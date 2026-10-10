'use client';

import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { toast } from '@/components/toast';
import { keys } from './queries';
import { meKey } from './session';
import type { FloorEvent } from './types';

export type LiveState = 'connecting' | 'live' | 'reconnecting';
const LiveContext = createContext<LiveState>('connecting');
export const useLiveState = () => useContext(LiveContext);

/**
 * One Server-Sent Events connection per signed-in tab. Every change on the
 * floor (web, station, or anything else) refreshes what's on screen, and
 * other people's check-outs and returns show as a brief notice.
 */
export function LiveFloorProvider({ meId, children }: { meId: string; children: ReactNode }) {
  const qc = useQueryClient();
  const [state, setState] = useState<LiveState>('connecting');

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let backoff = 1000;
    let stopped = false;

    const refreshFloor = () => {
      void qc.invalidateQueries({ queryKey: ['tools'] });
      void qc.invalidateQueries({ queryKey: ['tool'] });
      void qc.invalidateQueries({ queryKey: ['checkouts'] });
      void qc.invalidateQueries({ queryKey: keys.dashboard });
    };

    const connect = () => {
      source = new EventSource('/api/events');
      source.addEventListener('ready', () => {
        setState('live');
        backoff = 1000;
        refreshFloor(); // catch up on anything missed while disconnected
      });
      source.addEventListener('floor', (msg) => {
        const e = JSON.parse((msg as MessageEvent<string>).data) as FloorEvent;
        if (e.kind === 'station_event') {
          void qc.invalidateQueries({ queryKey: keys.stationEvents });
          void qc.invalidateQueries({ queryKey: keys.stations });
          return;
        }
        refreshFloor();
        if (e.message && e.actorId !== meId && (e.kind === 'checked_out' || e.kind === 'returned')) {
          toast(e.message, 'info');
        }
      });
      source.addEventListener('signed_out', () => {
        stopped = true;
        source?.close();
        qc.setQueryData(meKey, null);
      });
      source.onerror = () => {
        source?.close();
        if (stopped) return;
        setState('reconnecting');
        retryTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      };
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      source?.close();
    };
  }, [meId, qc]);

  return <LiveContext.Provider value={state}>{children}</LiveContext.Provider>;
}

/** Small status light: is this screen live? */
export function LiveBadge({ tone = 'dark' }: { tone?: 'dark' | 'light' }) {
  const state = useLiveState();
  const label = { connecting: 'Connecting', live: 'Live', reconnecting: 'Reconnecting' }[state];
  const dot = { connecting: 'bg-white/50', live: 'bg-[#7ee2a8]', reconnecting: 'bg-safety' }[state];
  return (
    <span
      role="status"
      aria-label={`Live updates: ${label.toLowerCase()}`}
      title={state === 'live' ? 'Changes appear here as they happen' : 'Trying to reconnect for live updates'}
      className={`inline-flex items-center gap-1.5 text-xs font-semibold ${tone === 'dark' ? 'text-machine-ink/85' : 'text-muted'}`}
    >
      <span className="relative flex size-2">
        {state === 'live' && (
          <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:hidden ${dot}`} />
        )}
        <span className={`relative inline-flex size-2 rounded-full ${dot}`} />
      </span>
      {label}
    </span>
  );
}
