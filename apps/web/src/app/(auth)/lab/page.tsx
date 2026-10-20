'use client';

import { CheckCircle2, FlaskConical } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, ErrorNote, Field, Input, Spinner } from '@/components/ui';
import { api, apiForm, errorText } from '@/lib/api';
import { formatDay, todayIso } from '@/lib/format';

interface LabJob {
  assetTag: string;
  toolName: string;
  labName: string;
  sentAt: string;
  expectedBackOn: string;
  intervalDays: number;
}

const dayOf = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** The calibration lab's page: no account, one tool, one use. Opened from the link the crib sent. */
export default function LabPage() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [job, setJob] = useState<LabJob | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ assetTag: string; dueOn: string } | null>(null);
  const readOnce = useRef(false);

  useEffect(() => {
    if (readOnce.current) return;
    readOnce.current = true;
    // The token is in the URL fragment, which browsers never send to servers or keep in logs.
    const t = new URLSearchParams(window.location.hash.slice(1)).get('token');
    setToken(t);
    if (!t) return;
    history.replaceState(null, '', window.location.pathname);
    api<{ job: LabJob }>('/lab/job', { body: { token: t } })
      .then((r) => setJob(r.job))
      .catch((err) => setError(errorText(err)));
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError('');
    const form = new FormData(e.currentTarget);
    form.set('token', token);
    const file = form.get('certificate');
    if (file instanceof File && file.size === 0) form.delete('certificate');
    try {
      const r = await apiForm<{ assetTag: string; dueOn: string }>('/lab/results', form);
      setDone(r);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (token === undefined) return null;
  if (!token) {
    return (
      <>
        <h1 className="text-[2.2rem] font-semibold">Link needed</h1>
        <p className="mt-2 text-muted">Open the full link the tool crib sent you.</p>
      </>
    );
  }
  if (done) {
    return (
      <div className="flex flex-col gap-3">
        <CheckCircle2 className="size-10 text-ok" aria-hidden />
        <h1 className="text-[2.2rem] font-semibold">Thank you</h1>
        <p className="text-muted">
          The calibration of {done.assetTag} is recorded, valid until {formatDay(done.dueOn)}. The crib has been told. This link no longer works.
        </p>
      </div>
    );
  }
  if (!job) return error ? <ErrorNote>{error}</ErrorNote> : <Spinner />;

  return (
    <>
      <FlaskConical className="mb-3 size-9 text-machine" aria-hidden />
      <h1 className="text-[2.2rem] font-semibold leading-tight">Calibration result</h1>
      <p className="mt-2 text-muted">
        For <span className="tag-plate text-ink">{job.assetTag}</span> {job.toolName}, sent to {job.labName} on {formatDay(dayOf(job.sentAt))}.
        It is calibrated every {job.intervalDays} days.
      </p>
      <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
        <Field label="Calibration date" htmlFor="calibratedOn">
          <Input id="calibratedOn" name="calibratedOn" type="date" min={dayOf(job.sentAt)} max={todayIso()} defaultValue={todayIso()} required />
        </Field>
        <Field label="Calibrated by" htmlFor="performedBy" hint="Your name, as on the certificate.">
          <Input id="performedBy" name="performedBy" required maxLength={80} autoComplete="name" />
        </Field>
        <Field label="Certificate number" htmlFor="certificateRef">
          <Input id="certificateRef" name="certificateRef" maxLength={120} />
        </Field>
        <Field label="Certificate file" htmlFor="certificate" hint="PDF, JPEG or PNG, up to 3 MB.">
          <Input id="certificate" name="certificate" type="file" accept="application/pdf,image/jpeg,image/png" className="py-2" />
        </Field>
        <ErrorNote>{error}</ErrorNote>
        <Button type="submit" busy={busy}>
          Send the result
        </Button>
        <p className="text-sm text-muted">This link works once. If the tool failed calibration, call the crib instead.</p>
      </form>
    </>
  );
}
