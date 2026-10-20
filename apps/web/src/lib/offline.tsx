'use client';

/**
 * Knows whether we're online, holds this person's offline outbox, and replays
 * it when the connection comes back (on the "online" event, on load, and every
 * 15 seconds while anything is waiting).
 */
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from '@/components/toast';
import { api, ApiError, errorText } from './api';
import * as outbox from './outbox';
import type { Me } from './types';

interface OfflineState {
  online: boolean;
  items: outbox.OutboxItem[];
  syncing: boolean;
  queue: (item: outbox.OutboxItem) => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  syncNow: () => Promise<void>;
}

const OfflineContext = createContext<OfflineState | null>(null);

export const useOffline = () => useContext(OfflineContext);

export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

/** Errors that mean "try again later" rather than "this action can't happen". */
const isTransient = (err: unknown) =>
  err instanceof ApiError && (err.status === 0 || err.status === 401 || err.status === 429 || err.status >= 500);

export function OfflineProvider({ me, children }: { me: Me; children: ReactNode }) {
  const online = useOnline();
  const qc = useQueryClient();
  const [items, setItems] = useState<outbox.OutboxItem[]>([]);
  const [syncing, setSyncing] = useState(false);
  const busy = useRef(false);

  const refresh = useCallback(async () => setItems(await outbox.list(me.id)), [me.id]);
  useEffect(() => {
    void refresh();
    return outbox.subscribe(() => void refresh());
  }, [refresh]);
  useEffect(() => {
    outbox.rememberUser({ id: me.id, displayName: me.displayName, role: me.role });
  }, [me]);

  const syncNow = useCallback(async () => {
    if (busy.current || !navigator.onLine) return;
    const pending = (await outbox.list(me.id)).filter((i) => i.state === 'pending');
    if (pending.length === 0) return;
    busy.current = true;
    setSyncing(true);
    let synced = 0;
    try {
      for (const item of pending) {
        try {
          if (item.kind === 'checkout') {
            await api('/checkouts', {
              body: { assetTag: item.assetTag, dueBackAt: item.dueBackAt, queuedAt: item.queuedAt },
              idempotencyKey: item.id,
            });
          } else {
            await api(`/checkouts/${item.checkoutId}/return`, {
              body: { condition: item.condition, notes: item.notes },
              idempotencyKey: item.id,
            });
          }
          await outbox.remove(item.id);
          synced++;
          toast(`Synced: ${item.kind === 'checkout' ? `${item.assetTag} checked out` : `${item.assetTag} received back`}`);
        } catch (err) {
          if (isTransient(err)) break; // still offline, or signed out: keep it and try later
          await outbox.put({ ...item, state: 'failed', error: errorText(err) });
        }
      }
    } finally {
      busy.current = false;
      setSyncing(false);
      if (synced) {
        await Promise.all(
          ['tools', 'tool', 'checkouts', 'dashboard', 'insights'].map((k) => qc.invalidateQueries({ queryKey: [k] })),
        );
      }
    }
  }, [me.id, qc]);

  useEffect(() => {
    if (online) void syncNow();
  }, [online, syncNow]);
  const waiting = items.some((i) => i.state === 'pending');
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void syncNow(), 15_000);
    return () => clearInterval(t);
  }, [waiting, syncNow]);

  const queue = useCallback(async (item: outbox.OutboxItem) => {
    await outbox.put(item);
    if (navigator.onLine) void syncNow();
  }, [syncNow]);
  const dismiss = useCallback((id: string) => outbox.remove(id), []);

  return (
    <OfflineContext.Provider value={{ online, items, syncing, queue, dismiss, syncNow }}>
      {children}
    </OfflineContext.Provider>
  );
}
