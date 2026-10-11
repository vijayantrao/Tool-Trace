/**
 * The offline outbox: actions taken with no connection, kept in IndexedDB until
 * they can be sent. Each item's id is also its Idempotency-Key, so sending one
 * twice (a retry, two open tabs) still only does it once on the server.
 *
 * Items belong to the person who made them and are only ever sent with that
 * person's own session. Signing out discards that person's unsent items.
 */

export type OutboxItem =
  | {
      id: string;
      userId: string;
      kind: 'checkout';
      assetTag: string;
      dueBackAt: string;
      queuedAt: string;
      state: 'pending' | 'failed';
      error?: string;
    }
  | {
      id: string;
      userId: string;
      kind: 'return';
      assetTag: string;
      checkoutId: string;
      condition: 'ok' | 'damaged' | 'needs_calibration';
      notes?: string;
      queuedAt: string;
      state: 'pending' | 'failed';
      error?: string;
    };

const DB = 'tooltrace';
const STORE = 'outbox';
const CHANNEL = 'tooltrace-outbox';
const LAST_USER = 'tooltrace.lastUser';

// If IndexedDB is unavailable (some private modes), fall back to memory for this tab.
const memory = new Map<string, OutboxItem>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;
function notify() {
  listeners.forEach((l) => l());
  channel?.postMessage('changed');
}

/** Called whenever the outbox changes, in this tab or another one. */
export function subscribe(listener: () => void): () => void {
  if (!channel && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = () => listeners.forEach((l) => l());
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function list(userId: string): Promise<OutboxItem[]> {
  const all = (await tx<OutboxItem[]>('readonly', (s) => s.getAll())) ?? [...memory.values()];
  return all.filter((i) => i.userId === userId).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

export async function put(item: OutboxItem): Promise<void> {
  if ((await open()) === null) memory.set(item.id, item);
  else await tx('readwrite', (s) => s.put(item));
  notify();
}

export async function remove(id: string): Promise<void> {
  memory.delete(id);
  await tx('readwrite', (s) => s.delete(id));
  notify();
}

export async function clear(userId: string): Promise<void> {
  for (const item of await list(userId)) {
    memory.delete(item.id);
    await tx('readwrite', (s) => s.delete(item.id));
  }
  notify();
}

/** Who was signed in on this device last, so the offline page knows whose actions it is queueing. */
export interface LastUser {
  id: string;
  displayName: string;
  role: string;
}

export function rememberUser(u: LastUser | null) {
  try {
    if (u) localStorage.setItem(LAST_USER, JSON.stringify(u));
    else localStorage.removeItem(LAST_USER);
  } catch {
    // Storage blocked: the offline page just won't offer queueing.
  }
}

export function lastUser(): LastUser | null {
  try {
    const raw = localStorage.getItem(LAST_USER);
    return raw ? (JSON.parse(raw) as LastUser) : null;
  } catch {
    return null;
  }
}

export function newCheckoutItem(userId: string, assetTag: string, hours: number): OutboxItem {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    userId,
    kind: 'checkout',
    assetTag: assetTag.toUpperCase(),
    dueBackAt: new Date(now + hours * 3_600_000).toISOString(),
    queuedAt: new Date(now).toISOString(),
    state: 'pending',
  };
}

export const describeItem = (i: OutboxItem) =>
  i.kind === 'checkout' ? `Check out ${i.assetTag}` : `Receive ${i.assetTag} back`;
