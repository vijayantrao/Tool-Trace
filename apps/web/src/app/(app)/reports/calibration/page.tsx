'use client';

import Link from 'next/link';
import { ArrowLeft, Printer } from 'lucide-react';
import { CertificateLink } from '@/components/calibration-lab';
import { Button, ErrorNote, Spinner } from '@/components/ui';
import { errorText } from '@/lib/api';
import { formatDay } from '@/lib/format';
import { useCalibrationRegister } from '@/lib/queries';

const stateText = { ok: 'Valid', due_soon: 'Due soon', expired: 'Expired: locked' } as const;

/** The register an auditor asks for: every calibration-controlled tool, its last calibration and certificate. Prints cleanly. */
export default function CalibrationRegisterPage() {
  const { data, isLoading, isError, error } = useCalibrationRegister();
  if (isLoading) return <Spinner />;
  if (isError || !data) return <ErrorNote>{errorText(error)}</ErrorNote>;
  const withCert = data.tools.filter((t) => t.hasCertificate).length;
  const expired = data.tools.filter((t) => t.calibrationState === 'expired').length;

  return (
    <div>
      <div className="no-print mb-5 flex flex-wrap items-center justify-between gap-3">
        <Link href="/reports" className="inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-ink">
          <ArrowLeft className="size-4" aria-hidden /> Reports
        </Link>
        <Button onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden /> Print or save as PDF
        </Button>
      </div>

      <header className="mb-5">
        <h1 className="text-[2rem] font-semibold">Calibration register</h1>
        <p className="text-muted">
          As of {formatDay(data.today)} ({data.timeZone}). {data.tools.length} calibration-controlled tools, {expired} expired, {withCert} with a
          certificate on file.
        </p>
      </header>

      <div className="overflow-x-auto rounded-lg border border-line bg-panel print:overflow-visible print:border-black/30">
        <table className="w-full min-w-[56rem] text-left text-sm print:min-w-0 print:text-[9pt]">
          <thead className="border-b border-line text-muted">
            <tr>
              <th className="px-3 py-2 font-semibold">Asset tag</th>
              <th className="px-3 py-2 font-semibold">Tool</th>
              <th className="px-3 py-2 font-semibold">Location</th>
              <th className="px-3 py-2 font-semibold">Every</th>
              <th className="px-3 py-2 font-semibold">Last calibrated</th>
              <th className="px-3 py-2 font-semibold">Valid until</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 font-semibold">Certificate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data.tools.map((t) => (
              <tr key={t.id} className="break-inside-avoid">
                <td className="tag-plate px-3 py-2">
                  <Link href={`/tools/${t.id}`} className="hover:underline">
                    {t.assetTag}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  {t.name}
                  {(t.make || t.model) && <span className="block text-xs text-muted">{[t.make, t.model].filter(Boolean).join(' ')}</span>}
                </td>
                <td className="px-3 py-2">{t.location}</td>
                <td className="px-3 py-2 tabular-nums">{t.calibrationIntervalDays} days</td>
                <td className="px-3 py-2">
                  {t.lastCalibratedOn ? formatDay(t.lastCalibratedOn) : '–'}
                  {t.performedBy && <span className="block text-xs text-muted">{t.performedBy}</span>}
                </td>
                <td className="px-3 py-2">{formatDay(t.calibrationDueOn)}</td>
                <td className={`px-3 py-2 font-semibold ${t.calibrationState === 'expired' ? 'text-signal' : ''}`}>
                  {stateText[t.calibrationState]}
                  {t.atLab && <span className="block text-xs font-normal text-muted">At {t.atLab}</span>}
                </td>
                <td className="px-3 py-2">
                  {t.certificateRef && <span className="block">{t.certificateRef}</span>}
                  {t.hasCertificate && t.recordId ? (
                    <span className="no-print">
                      <CertificateLink recordId={t.recordId} fileName={`${t.assetTag}-certificate`} />
                    </span>
                  ) : (
                    !t.certificateRef && <span className="text-muted">None on file</span>
                  )}
                  {t.hasCertificate && <span className="hidden print:inline">File on record</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
