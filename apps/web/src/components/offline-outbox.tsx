'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { OfflineCheckout } from '@/components/offline-checkout';
import { parseTag } from '@/components/qr-scanner';
import { Button, ErrorNote, Field, Input } from '@/components/ui';
import * as outbox from '@/lib/outbox';

const CAN_CHECK_OUT = new Set(['admin', 'storekeeper', 'technician']);

/** On the offline fallback page: what's waiting to be sent, and a way to queue a check-out by tag. */
export function OfflineOutbox() {
  const [user, setUser] = useState<outbox.LastUser | null>(null);
  const [items, setItems] = useState<outbox.OutboxItem[]>([]);
  const [manual, setManual] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const u = outbox.lastUser();
    setUser(u);
    setItems(u ? await outbox.list(u.id) : []);
  }, []);
  useEffect(() => {
    void refresh();
    return outbox.subscribe(() => void refresh());
  }, [refresh]);
  useEffect(() => {
    // Back online: go back to the app, which sends what's waiting.
    const back = () => location.replace('/');
    window.addEventListener('online', back);
    return () => window.removeEventListener('online', back);
  }, []);

  if (!user || !CAN_CHECK_OUT.has(user.role)) return null;

  function submit(e: FormEvent) {
    e.preventDefault();
    const t = parseTag(manual);
    if (!t) setError('Asset tags use letters, digits and dashes, like TW-0101.');
    else setTag(t);
  }

  return (
    <div className="mt-6 text-left">
      {items.length > 0 && (
        <div role="status" className="mb-4 rounded-md bg-due-soft p-3 text-sm">
          <p className="font-semibold">
            {items.length} {items.length === 1 ? 'action' : 'actions'} saved on this phone, waiting to be sent:
          </p>
          <ul className="mt-1">
            {items.map((i) => (
              <li key={i.id}>{outbox.describeItem(i)}</li>
            ))}
          </ul>
        </div>
      )}
      {tag ? (
        <OfflineCheckout
          tag={tag}
          userId={user.id}
          onCancel={() => setTag(null)}
          onQueue={async (item) => {
            await outbox.put(item);
            setTag(null);
            setManual('');
          }}
        />
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <Field label={`Taking a tool, ${user.displayName.split(' ')[0]}? Type its asset tag`} htmlFor="offline-tag">
            <div className="flex gap-2">
              <Input
                id="offline-tag"
                value={manual}
                onChange={(e) => {
                  setManual(e.target.value);
                  setError('');
                }}
                placeholder="TW-0101"
                className="tag-plate uppercase"
                autoCapitalize="characters"
                autoComplete="off"
              />
              <Button type="submit" disabled={!manual.trim()}>
                Next
              </Button>
            </div>
          </Field>
          <ErrorNote>{error}</ErrorNote>
        </form>
      )}
    </div>
  );
}
