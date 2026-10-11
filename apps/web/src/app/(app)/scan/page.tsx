'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState, type FormEvent } from 'react';
import { OfflineCheckout } from '@/components/offline-checkout';
import { parseTag, QrScanner } from '@/components/qr-scanner';
import { toast } from '@/components/toast';
import { Button, ErrorNote, Field, Input, PageHeader } from '@/components/ui';
import { useOffline } from '@/lib/offline';
import { can, useMe } from '@/lib/session';

export default function ScanPage() {
  const router = useRouter();
  const { data: me } = useMe();
  const offline = useOffline();
  const [manual, setManual] = useState('');
  const [error, setError] = useState('');
  const [offlineTag, setOfflineTag] = useState<string | null>(null);
  const isOffline = offline !== null && !offline.online;

  const onTag = useCallback(
    (tag: string) => {
      // Without a connection the tool page can't load: offer an offline check-out instead.
      if (isOffline) {
        if (can.checkOut(me?.role)) setOfflineTag(tag);
        else setError('You’re offline. Reconnect to look this tool up.');
        return;
      }
      router.push(`/t/${encodeURIComponent(tag)}`);
    },
    [isOffline, me?.role, router],
  );
  const onUnknown = useCallback(() => setError("That QR code isn't a ToolTrace label."), []);

  function submit(e: FormEvent) {
    e.preventDefault();
    const tag = parseTag(manual);
    if (!tag) {
      setError('Asset tags use letters, digits and dashes, like TW-0101.');
      return;
    }
    onTag(tag);
  }

  return (
    <div className="mx-auto max-w-md">
      <PageHeader title="Scan a tool" />
      {offlineTag && me && offline ? (
        <OfflineCheckout
          tag={offlineTag}
          userId={me.id}
          onCancel={() => setOfflineTag(null)}
          onQueue={async (item) => {
            await offline.queue(item);
            toast(`Saved offline: ${item.assetTag} will be checked out to you when you're back online`, 'info');
            setOfflineTag(null);
            setManual('');
          }}
        />
      ) : (
        <>
          <QrScanner onTag={onTag} onUnknown={onUnknown} />
          <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
            <Field label="Or type the asset tag" htmlFor="tag">
              <div className="flex gap-2">
                <Input
                  id="tag"
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
                  Find
                </Button>
              </div>
            </Field>
            <ErrorNote>{error}</ErrorNote>
          </form>
        </>
      )}
    </div>
  );
}
