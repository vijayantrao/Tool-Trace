'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState, type FormEvent } from 'react';
import { parseTag, QrScanner } from '@/components/qr-scanner';
import { Button, ErrorNote, Field, Input, PageHeader } from '@/components/ui';

export default function ScanPage() {
  const router = useRouter();
  const [manual, setManual] = useState('');
  const [error, setError] = useState('');

  const onTag = useCallback((tag: string) => router.push(`/t/${encodeURIComponent(tag)}`), [router]);
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
    </div>
  );
}
