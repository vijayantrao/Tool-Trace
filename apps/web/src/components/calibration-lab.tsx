'use client';

import { Copy, FileText, FlaskConical, Paperclip } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from '@/components/toast';
import { Button, ErrorNote, Field, Input } from '@/components/ui';
import { errorText } from '@/lib/api';
import { formatDateTime, formatDay, todayIso } from '@/lib/format';
import { useCancelLab, useLabResults, useReceiveFromLab, useReissueLabLink, useSendToLab, useUploadCertificate } from '@/lib/queries';
import type { ToolDetail } from '@/lib/types';

const plusDays = (n: number) => {
  const d = new Date(Date.now() + n * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** The lab's single-use link, shown once, with a copy button. */
function LabLink({ link, emailed, labEmail }: { link: string; emailed: boolean; labEmail?: string | null }) {
  return (
    <div className="rounded-md border border-safety bg-due-soft p-3 text-sm">
      <p className="font-semibold">
        {emailed ? `The lab's link was emailed to ${labEmail}.` : 'Send this link to the lab (WhatsApp, email, a printout):'}
      </p>
      <p className="mt-1 text-muted">It works once, for this tool only, and needs no account. You won&apos;t see it again here.</p>
      <div className="mt-2 flex gap-2">
        <Input readOnly value={link} aria-label="Lab link" onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
        <Button
          type="button"
          variant="quiet"
          className="bg-panel"
          onClick={async () => {
            await navigator.clipboard.writeText(link).catch(() => {});
            toast('Link copied');
          }}
        >
          <Copy className="size-4" aria-hidden /> Copy
        </Button>
      </div>
    </div>
  );
}

export function SendToLabForm({ tool, onClose }: { tool: ToolDetail; onClose: () => void }) {
  const send = useSendToLab();
  const [error, setError] = useState('');
  const [sent, setSent] = useState<{ link: string; emailed: boolean; labEmail?: string } | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const f = new FormData(e.currentTarget);
    const labEmail = String(f.get('labEmail')).trim();
    try {
      const res = await send.mutateAsync({
        toolId: tool.id,
        labName: String(f.get('labName')).trim(),
        labEmail: labEmail || undefined,
        expectedBackOn: String(f.get('expectedBackOn')),
        notes: String(f.get('notes')).trim() || undefined,
      });
      toast(`${tool.assetTag} is off the board: at the calibration lab`);
      setSent({ link: res.labLink, emailed: res.emailed, labEmail });
    } catch (err) {
      setError(errorText(err));
    }
  }

  if (sent) {
    return (
      <div className="mt-4 flex flex-col gap-3">
        <LabLink link={sent.link} emailed={sent.emailed} labEmail={sent.labEmail} />
        <Button variant="quiet" className="self-start" onClick={onClose}>
          Done
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-4 grid gap-4 rounded-md bg-board p-4 sm:grid-cols-2">
      <Field label="Calibration lab" htmlFor="labName">
        <Input id="labName" name="labName" required maxLength={120} defaultValue="External Calibration Lab" />
      </Field>
      <Field label="Lab email (optional)" htmlFor="labEmail" hint="They get a link to enter the result and attach the certificate.">
        <Input id="labEmail" name="labEmail" type="email" maxLength={254} placeholder="calibration@lab.example" />
      </Field>
      <Field label="Expected back" htmlFor="expectedBackOn">
        <Input id="expectedBackOn" name="expectedBackOn" type="date" min={todayIso()} defaultValue={plusDays(7)} required />
      </Field>
      <Field label="Note for the lab (optional)" htmlFor="labNotes">
        <Input id="labNotes" name="notes" maxLength={500} placeholder="NABL certificate please" />
      </Field>
      <div className="flex flex-col gap-3 sm:col-span-2">
        <ErrorNote>{error}</ErrorNote>
        <div className="flex gap-2">
          <Button type="submit" busy={send.isPending}>
            Send {tool.assetTag} for calibration
          </Button>
          <Button type="button" variant="quiet" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </form>
  );
}

/** While the tool is at the lab: where, since when, and what the crib can do. */
export function LabPanel({ tool, canManage }: { tool: ToolDetail; canManage: boolean }) {
  const job = tool.labJob;
  const reissue = useReissueLabLink();
  const receive = useReceiveFromLab();
  const cancel = useCancelLab();
  const results = useLabResults();
  const [link, setLink] = useState<{ link: string; emailed: boolean } | null>(null);
  const [entering, setEntering] = useState(false);
  const [error, setError] = useState('');

  if (!job) {
    return (
      <div className="flex gap-3 rounded-lg border-2 border-safety bg-due-soft p-5">
        <FlaskConical className="mt-0.5 size-6 shrink-0" aria-hidden />
        <div>
          <h2 className="text-xl font-semibold">At the calibration lab</h2>
          <p className="mt-1">It can&apos;t be checked out until it is back and received at the crib.</p>
        </div>
      </div>
    );
  }

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setError('');
    try {
      await fn();
      toast(done);
    } catch (err) {
      setError(errorText(err));
    }
  };

  async function submitResults(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const form = new FormData(e.currentTarget);
    const file = form.get('certificate');
    if (file instanceof File && file.size === 0) form.delete('certificate');
    try {
      const r = await results.mutateAsync({ jobId: job!.id, form });
      toast(`Result recorded. Valid until ${formatDay(r.dueOn)}`);
      setEntering(false);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="rounded-lg border-2 border-safety bg-due-soft p-5">
      <div className="flex gap-3">
        <FlaskConical className="mt-0.5 size-6 shrink-0" aria-hidden />
        <div className="min-w-0">
          <h2 className="text-xl font-semibold">At {job.labName}</h2>
          <p className="mt-1">
            Sent {formatDateTime(job.sentAt)} by {job.sentByName}.{' '}
            <span className={job.late ? 'font-semibold text-signal' : ''}>
              {job.late ? 'Late: was expected back ' : 'Expected back '}
              {formatDay(job.expectedBackOn)}.
            </span>
          </p>
          {job.notes && <p className="mt-1 text-sm text-muted">Note: {job.notes}</p>}
          <p className="mt-2 text-sm font-semibold">
            {job.status === 'calibrated'
              ? `Result in (${job.resultsVia === 'lab' ? 'entered by the lab' : 'entered at the crib'}). Receive it when it is back.`
              : job.tokenExpiresAt
                ? `Waiting for the lab's result${job.labEmail ? ` (link emailed to ${job.labEmail})` : ''}.`
                : "Waiting for the lab's result."}
          </p>
        </div>
      </div>

      {canManage && (
        <div className="mt-4 flex flex-col gap-3 border-t border-safety/60 pt-4">
          {link && <LabLink link={link.link} emailed={link.emailed} labEmail={job.labEmail} />}
          {entering && job.status === 'at_lab' && (
            <form onSubmit={submitResults} className="grid gap-4 rounded-md bg-panel p-4 sm:grid-cols-2">
              <Field label="Calibration date" htmlFor="labCalibratedOn">
                <Input id="labCalibratedOn" name="calibratedOn" type="date" max={todayIso()} defaultValue={todayIso()} required />
              </Field>
              <Field label="Calibrated by" htmlFor="labPerformedBy">
                <Input id="labPerformedBy" name="performedBy" required maxLength={80} defaultValue={job.labName} />
              </Field>
              <Field label="Certificate number (optional)" htmlFor="labCertRef">
                <Input id="labCertRef" name="certificateRef" maxLength={120} />
              </Field>
              <Field label="Certificate file (optional)" htmlFor="labCertFile" hint="PDF, JPEG or PNG, up to 3 MB.">
                <Input id="labCertFile" name="certificate" type="file" accept="application/pdf,image/jpeg,image/png" className="py-2" />
              </Field>
              <div className="flex gap-2 sm:col-span-2">
                <Button type="submit" busy={results.isPending}>
                  Save result
                </Button>
                <Button type="button" variant="quiet" onClick={() => setEntering(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
          <ErrorNote>{error}</ErrorNote>
          <div className="flex flex-wrap gap-2">
            {job.status === 'calibrated' ? (
              <>
                <Button busy={receive.isPending} onClick={() => act(() => receive.mutateAsync({ jobId: job.id, outcome: 'passed' }), `${tool.assetTag} is back on the board`)}>
                  Received: back in service
                </Button>
                <Button variant="quiet" className="bg-panel" onClick={() => act(() => receive.mutateAsync({ jobId: job.id, outcome: 'failed' }), `${tool.assetTag} received and quarantined`)}>
                  Received: failed calibration
                </Button>
              </>
            ) : (
              <>
                {!entering && (
                  <Button variant="quiet" className="bg-panel" onClick={() => setEntering(true)}>
                    Enter result from a certificate
                  </Button>
                )}
                <Button
                  variant="quiet"
                  className="bg-panel"
                  busy={reissue.isPending}
                  onClick={() =>
                    act(async () => {
                      const r = await reissue.mutateAsync(job.id);
                      setLink({ link: r.labLink, emailed: r.emailed });
                    }, 'New lab link ready (the old one no longer works)')
                  }
                >
                  New link for the lab
                </Button>
                <Button variant="quiet" className="bg-panel" onClick={() => act(() => receive.mutateAsync({ jobId: job.id, outcome: 'failed' }), `${tool.assetTag} received and quarantined`)}>
                  Back, failed calibration
                </Button>
                <Button variant="quiet" className="bg-panel" onClick={() => act(() => cancel.mutateAsync(job.id), 'Trip cancelled: the tool is back as it was')}>
                  It never left
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Download link for a calibration's certificate. */
export function CertificateLink({ recordId, fileName }: { recordId: string; fileName: string }) {
  return (
    <a
      href={`/api/calibration-records/${recordId}/certificate`}
      className="inline-flex items-center gap-1 font-semibold text-ink underline decoration-line underline-offset-2 hover:decoration-ink"
      download
      title={fileName}
    >
      <FileText className="size-4" aria-hidden /> Certificate
    </a>
  );
}

/** For a calibration recorded without one. */
export function AttachCertificate({ recordId }: { recordId: string }) {
  const upload = useUploadCertificate();
  return (
    <label className="inline-flex cursor-pointer items-center gap-1 font-semibold text-muted hover:text-ink">
      <Paperclip className="size-4" aria-hidden />
      {upload.isPending ? 'Uploading…' : 'Attach certificate'}
      <input
        type="file"
        accept="application/pdf,image/jpeg,image/png"
        className="sr-only"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          const form = new FormData();
          form.append('certificate', file);
          try {
            await upload.mutateAsync({ recordId, form });
            toast('Certificate attached');
          } catch (err) {
            toast(errorText(err), 'error');
          }
        }}
      />
    </label>
  );
}
