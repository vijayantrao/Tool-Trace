'use client';

import { useState, type FormEvent } from 'react';
import { toast } from '@/components/toast';
import { Button, ErrorNote, Field, Input, Select } from '@/components/ui';
import { api, errorText } from '@/lib/api';
import { useCreateRequest, useStock } from '@/lib/queries';
import type { RequestKind, RequestReason, ToolDetail } from '@/lib/types';

export const kindLabel: Record<RequestKind, string> = {
  new_tool: 'New tool',
  replacement: 'Replacement',
  stock: 'PPE or stock',
};

export const reasonLabel: Record<RequestReason, string> = {
  new_requirement: 'New requirement',
  damaged: 'Replacement against damaged',
  missing: 'Issuance against missing',
  kaizen: 'Kaizen improvement',
  used_up: 'Used up',
  other: 'Other',
};

const reasonsFor: Record<RequestKind, RequestReason[]> = {
  new_tool: ['new_requirement', 'kaizen', 'other'],
  replacement: ['damaged', 'missing', 'kaizen'],
  stock: ['used_up', 'new_requirement', 'other'],
};

/** Ask for a new tool, a replacement or stock. Opened from the Requests page, or from a tool ("Request replacement"). */
export function RequestForm({ tool, onDone }: { tool?: Pick<ToolDetail, 'id' | 'assetTag' | 'name' | 'unitPrice'>; onDone: () => void }) {
  const create = useCreateRequest();
  const [kind, setKind] = useState<RequestKind>(tool ? 'replacement' : 'new_tool');
  const stock = useStock();
  const [error, setError] = useState('');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const f = new FormData(e.currentTarget);
    const cost = String(f.get('estimatedCost') ?? '').trim();
    try {
      let toolId = tool?.id;
      if (kind === 'replacement' && !toolId) {
        const tag = String(f.get('toolTag')).trim().toUpperCase();
        toolId = (await api<{ tool: { id: string } }>(`/tools/by-tag/${encodeURIComponent(tag)}`).catch(() => {
          throw new Error(`No tool with asset tag ${tag}`);
        })).tool.id;
      }
      const stockItemId = kind === 'stock' ? String(f.get('stockItemId') || '') || undefined : undefined;
      const res = await create.mutateAsync({
        kind,
        reason: String(f.get('reason')) as RequestReason,
        title: String(f.get('title')).trim(),
        details: String(f.get('details')).trim() || undefined,
        quantity: Number(f.get('quantity') || 1),
        estimatedCost: cost ? Number(cost) : undefined,
        toolId: kind === 'replacement' ? toolId : undefined,
        stockItemId,
      });
      toast(`Request REQ-${String(res.request.number).padStart(4, '0')} sent for review`);
      onDone();
    } catch (err) {
      setError(err instanceof Error && !('status' in err) ? err.message : errorText(err));
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      {!tool && (
        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-sm font-semibold">What do you need?</legend>
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(kindLabel) as RequestKind[]).map((k) => (
              <button
                type="button"
                key={k}
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={`min-h-11 rounded-md px-2 text-sm font-semibold ${kind === k ? 'bg-ink text-panel' : 'ring-1 ring-inset ring-line hover:ring-ink/40'}`}
              >
                {kindLabel[k]}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {kind === 'replacement' && !tool && (
        <Field label="Tool to replace (asset tag)" htmlFor="toolTag">
          <Input id="toolTag" name="toolTag" required placeholder="TW-0101" className="uppercase" />
        </Field>
      )}
      {kind === 'stock' && (
        <Field label="Stock item (optional)" htmlFor="stockItemId">
          <Select id="stockItemId" name="stockItemId" defaultValue="">
            <option value="">Something not stocked yet</option>
            {stock.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} {s.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Reason" htmlFor="reason">
        <Select id="reason" name="reason" key={kind} defaultValue={reasonsFor[kind][0]}>
          {reasonsFor[kind].map((r) => (
            <option key={r} value={r}>
              {reasonLabel[r]}
            </option>
          ))}
        </Select>
      </Field>
      <div className="sm:col-span-2">
        <Field label="What is needed" htmlFor="title">
          <Input id="title" name="title" required maxLength={120} defaultValue={tool?.name ?? ''} placeholder="Torque wrench 20-100 Nm" />
        </Field>
      </div>
      <Field label="Quantity" htmlFor="quantity">
        <Input id="quantity" name="quantity" type="number" min={1} max={100000} defaultValue={1} required />
      </Field>
      <Field label="Estimated cost (optional)" htmlFor="estimatedCost">
        <Input id="estimatedCost" name="estimatedCost" type="number" min={0} step="0.01" inputMode="decimal" defaultValue={tool?.unitPrice ?? ''} />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Details (optional)" htmlFor="details" hint="What happened, or why it helps. The reviewer sees this.">
          <Input id="details" name="details" maxLength={1000} placeholder={tool ? 'Ratchet slips under load' : ''} />
        </Field>
      </div>
      <div className="flex flex-col gap-3 sm:col-span-2">
        <ErrorNote>{error}</ErrorNote>
        <div className="flex gap-2">
          <Button type="submit" busy={create.isPending}>
            Send request
          </Button>
          <Button type="button" variant="quiet" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </div>
    </form>
  );
}
