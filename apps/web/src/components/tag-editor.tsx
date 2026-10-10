'use client';

import { Nfc } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { errorText } from '@/lib/api';
import { formatUid } from '@/lib/format';
import { toast } from './toast';
import { Button, Input } from './ui';

/**
 * Shows an RFID UID (badge or tool tag) and, for people allowed to, lets them
 * assign, change or remove it. Accepts "c0:ff:ee:99", "C0 FF EE 99", "c0ffee99"...
 */
export function TagEditor({
  label,
  value,
  canEdit,
  onSave,
  savedMessage,
}: {
  label: string;
  value: string | null;
  canEdit: boolean;
  onSave: (uid: string | null) => Promise<unknown>;
  savedMessage: (uid: string | null) => string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputId = useId();

  const save = async (uid: string | null) => {
    setBusy(true);
    setError('');
    try {
      await onSave(uid);
      toast(savedMessage(uid));
      setEditing(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Nfc className="size-4 text-muted" aria-hidden />
        <span className="text-muted">{label}:</span>
        {value ? <span className="tag-plate">{formatUid(value)}</span> : <span className="text-muted">none</span>}
        {canEdit && (
          <button
            type="button"
            className="font-semibold text-machine underline-offset-2 hover:underline"
            onClick={() => {
              setDraft(value ? formatUid(value) : '');
              setEditing(true);
            }}
            aria-label={`${value ? 'Change' : 'Assign'} ${label.toLowerCase()}`}
          >
            {value ? 'Change' : 'Assign'}
          </button>
        )}
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void save(draft.trim() || null);
      }}
    >
      <label htmlFor={inputId} className="text-sm font-semibold">
        {label} ID
      </label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={inputId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="C0:FF:EE:99"
          className="tag-plate max-w-56 uppercase"
          autoComplete="off"
          autoFocus
        />
        <Button type="submit" busy={busy}>
          Save
        </Button>
        {value && (
          <Button type="button" variant="quiet" disabled={busy} onClick={() => void save(null)}>
            Remove
          </Button>
        )}
        <Button type="button" variant="quiet" disabled={busy} onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
      <p className="text-xs text-muted">Tap the tag on a station: unknown tags appear in Stations with their ID.</p>
      {error && (
        <p role="alert" className="text-sm text-signal">
          {error}
        </p>
      )}
    </form>
  );
}
