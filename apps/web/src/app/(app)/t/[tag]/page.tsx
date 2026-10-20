'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ErrorNote, LinkButton, Spinner } from '@/components/ui';
import { api, ApiError, errorText } from '@/lib/api';
import type { ToolDetail } from '@/lib/types';

/** Where printed QR labels point. Resolves an asset tag to its tool page. */
export default function TagRedirect() {
  const { tag } = useParams<{ tag: string }>();
  const router = useRouter();
  const assetTag = decodeURIComponent(tag).toUpperCase();
  const q = useQuery({
    queryKey: ['by-tag', assetTag],
    // A tag is a tool's or a kit's (never both).
    queryFn: async () => {
      try {
        return `/tools/${(await api<{ tool: ToolDetail }>(`/tools/by-tag/${encodeURIComponent(assetTag)}`)).tool.id}`;
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 404)) throw err;
        return `/kits/${(await api<{ kit: { id: string } }>(`/kits/by-tag/${encodeURIComponent(assetTag)}`)).kit.id}`;
      }
    },
  });

  useEffect(() => {
    if (q.data) router.replace(q.data);
  }, [q.data, router]);

  if (q.isError) {
    const missing = q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 422);
    return (
      <div className="mx-auto max-w-md py-10 text-center">
        <h1 className="text-3xl font-semibold">{missing ? `No tool tagged ${assetTag}` : 'Could not look that up'}</h1>
        <p className="mt-2 text-muted">
          {missing ? 'Check the label, or ask the crib whether this tool has been registered.' : ''}
        </p>
        {!missing && <ErrorNote>{errorText(q.error)}</ErrorNote>}
        <LinkButton href="/scan" className="mt-6">
          Scan another
        </LinkButton>
      </div>
    );
  }
  return <Spinner label={`Finding ${assetTag}`} />;
}
