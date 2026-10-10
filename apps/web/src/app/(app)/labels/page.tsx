'use client';

import QRCode from 'qrcode';
import { Printer } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Button, ErrorNote, PageHeader, Spinner } from '@/components/ui';
import { errorText } from '@/lib/api';
import { useTools } from '@/lib/queries';
import type { Tool } from '@/lib/types';

/** Printable sheet of QR labels. Each code opens the tool's page in ToolTrace. */
function Labels() {
  const params = useSearchParams();
  const tools = useTools();
  const preset = params.get('ids')?.split(',').filter(Boolean);
  const [selected, setSelected] = useState<Set<string> | null>(null);

  const active = useMemo(() => (tools.data ?? []).filter((t) => t.status !== 'retired'), [tools.data]);
  useEffect(() => {
    if (selected === null && tools.data) setSelected(new Set(preset?.length ? preset : active.map((t) => t.id)));
  }, [tools.data, selected, preset, active]);

  if (tools.isLoading || !selected) return <Spinner />;
  if (tools.isError) return <ErrorNote>{errorText(tools.error)}</ErrorNote>;

  const chosen = active.filter((t) => selected.has(t.id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <>
      <div className="no-print">
        <PageHeader
          title="QR labels"
          sub="Stick one on each tool. Scanning it with ToolTrace, or any phone camera, opens that tool's page."
          actions={
            <Button onClick={() => window.print()} disabled={chosen.length === 0}>
              <Printer className="size-4" aria-hidden /> Print {chosen.length} {chosen.length === 1 ? 'label' : 'labels'}
            </Button>
          }
        />
        <fieldset className="mb-6 flex flex-wrap gap-2">
          <legend className="sr-only">Tools to print</legend>
          {active.map((t) => (
            <label
              key={t.id}
              className={`tag-plate flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-3 text-sm ring-1 ring-inset ${
                selected.has(t.id) ? 'bg-panel ring-machine' : 'text-muted ring-line'
              }`}
            >
              <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} className="accent-machine" />
              {t.assetTag}
            </label>
          ))}
        </fieldset>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 print:grid-cols-3 print:gap-3">
        {chosen.map((t) => (
          <Label key={t.id} tool={t} />
        ))}
      </div>
    </>
  );
}

function Label({ tool }: { tool: Tool }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    const url = `${window.location.origin}/t/${encodeURIComponent(tool.assetTag)}`;
    QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 360, color: { dark: '#000000', light: '#ffffff' } })
      .then(setSrc)
      .catch(() => setSrc(''));
  }, [tool.assetTag]);

  return (
    <figure className="flex break-inside-avoid items-center gap-3 rounded-lg border-2 border-dashed border-line bg-white p-3 text-black print:border-black/40">
      {src ? <img src={src} alt={`QR code for ${tool.assetTag}`} className="size-24 shrink-0" /> : <div className="size-24" />}
      <figcaption className="min-w-0">
        <div className="tag-plate text-xl">{tool.assetTag}</div>
        <div className="line-clamp-2 text-sm leading-tight">{tool.name}</div>
        <div className="mt-1 text-xs text-black/60">ToolTrace</div>
      </figcaption>
    </figure>
  );
}

export default function LabelsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Labels />
    </Suspense>
  );
}
