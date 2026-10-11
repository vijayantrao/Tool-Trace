'use client';

import Link from 'next/link';
import { CircleAlert, CircleCheck, CircleDashed, Clock, CloudOff, Radar, ShieldAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from '@/components/toast';
import { AssetTag } from '@/components/tool-visuals';
import { Button, ErrorNote, Field, Input, PageHeader, Panel, Spinner } from '@/components/ui';
import { errorText } from '@/lib/api';
import { formatDateTime, relative } from '@/lib/format';
import { useInsights, useReviewAnomaly } from '@/lib/queries';
import { can, useMe } from '@/lib/session';
import type { Anomaly, AtRiskCheckout, Insights, ModelMetrics, MlRun } from '@/lib/types';

const pct = (p: number) => `${Math.round(p * 100)}%`;
const STALE_HOURS = 36;

export default function InsightsPage() {
  const { data: me } = useMe();
  const allowed = can.seeInsights(me?.role);
  const insights = useInsights(allowed);

  if (!allowed) return <ErrorNote>Only crib staff and auditors can see insights.</ErrorNote>;
  if (insights.isLoading) return <Spinner label="Loading insights" />;
  if (insights.isError) return <ErrorNote>{errorText(insights.error)}</ErrorNote>;
  const data = insights.data!;
  const { likelyLate, lossRisk } = data.thresholds;
  const scored = data.atRisk.filter((r) => r.lateProbability !== null);
  const counts = {
    late: scored.filter((r) => !r.overdue && r.lateProbability! >= likelyLate).length,
    loss: scored.filter((r) => r.lossProbability! >= lossRisk).length,
    review: data.anomalies.filter((a) => a.status === 'open').length,
  };

  return (
    <>
      <PageHeader
        title="Insights"
        sub="What the nightly model sees on the floor. A score is a prompt to check in early, never a verdict about a person."
      />

      <ModelHealth latest={data.latestRun} good={data.lastSuccessfulRun} />

      <section aria-label="Summary" className="mb-8 grid gap-3 sm:grid-cols-3">
        <StatTile label="Likely to come back late" value={counts.late} />
        <StatTile label="At risk of being lost" value={counts.loss} />
        <StatTile label="Unusual check-outs to review" value={counts.review} />
      </section>

      <section aria-labelledby="out-h" className="mb-10">
        <h2 id="out-h" className="mb-3 text-2xl font-semibold">
          Tools out now
        </h2>
        {data.atRisk.length === 0 ? (
          <p className="rounded-lg border border-line bg-panel px-4 py-8 text-center text-muted">Every tool is in the crib.</p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
            {data.atRisk.map((r) => (
              <RiskRow key={r.checkoutId} r={r} t={data.thresholds} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="odd-h">
        <h2 id="odd-h" className="text-2xl font-semibold">
          Unusual check-outs
        </h2>
        <p className="mb-3 mt-1 text-muted">
          Check-outs unlike the rest of the history: an odd hour for that person, an unusually long loan, a kind of tool
          they never use. Most have a good reason. A person decides.
        </p>
        {data.anomalies.length === 0 ? (
          <p className="rounded-lg border border-line bg-panel px-4 py-8 text-center text-muted">Nothing unusual flagged.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {data.anomalies.map((a) => (
              <AnomalyCard key={a.id} a={a} canReview={can.reviewAnomalies(me?.role)} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/* ---------------------------------------------------------------- summary */

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-3">
      <div className="text-sm text-muted">{label}</div>
      <div className="mt-1 text-3xl font-semibold">{value}</div>
    </div>
  );
}

function modelName(m?: ModelMetrics) {
  if (!m) return 'Not trained';
  return (
    { logistic_regression: 'Logistic regression', gradient_boosting: 'Gradient boosting', constant: 'Overall rate' }[
      m.model
    ] ?? m.model
  );
}

function ModelLine({ title, m, what, plural }: { title: string; m?: ModelMetrics; what: string; plural: string }) {
  let body: ReactNode;
  if (!m || m.model === 'constant' || !m.test?.rocAuc) {
    body = 'Not enough history yet, so every tool gets the overall rate.';
  } else if (m.testReliable === false) {
    // A score measured on a handful of cases is noise: say so instead of quoting it.
    body = `Only ${m.test.positives ?? 'a few'} ${plural} among the ${m.test.n} most recent check-outs (held back from training): too few to measure its accuracy reliably yet.`;
  } else {
    body = (
      <>
        On the {m.test.n} most recent check-outs (held back from training), it ranks {what} above one that wasn&apos;t{' '}
        <strong>{pct(m.test.rocAuc)}</strong> of the time
        {m.baselineTestRocAuc ? <> (a person&apos;s own track record alone: {pct(m.baselineTestRocAuc)})</> : null}.
      </>
    );
  }
  return (
    <div>
      <dt className="font-semibold">
        {title}: {modelName(m)}
      </dt>
      <dd className="text-muted">{body}</dd>
    </div>
  );
}

function ModelHealth({ latest, good }: { latest: MlRun | null; good: MlRun | null }) {
  if (!good) {
    return (
      <Panel className="mb-8 p-5">
        <h2 className="flex items-center gap-2 text-xl font-semibold">
          <Radar className="size-5" aria-hidden /> The model hasn&apos;t run yet
        </h2>
        <p className="mt-1 text-muted">
          It runs every night. To run it now: <code className="rounded bg-board px-1">python -m tooltrace_ml run</code>
        </p>
        {latest?.status === 'failed' && <ErrorNote>The last run failed: {latest.error}</ErrorNote>}
      </Panel>
    );
  }
  const ageHours = (Date.now() - new Date(good.finishedAt!).getTime()) / 3_600_000;
  return (
    <Panel className="mb-8 p-5">
      <h2 className="flex items-center gap-2 text-xl font-semibold">
        <Radar className="size-5" aria-hidden /> Model
      </h2>
      <p className="mt-1 text-muted">
        Last run {relative(good.finishedAt!)}, learned from {good.trainedOn?.toLocaleString() ?? 0} past check-outs.
      </p>
      {latest && latest.status === 'failed' && latest.id !== good.id && (
        <div className="mt-3">
          <ErrorNote>The latest run failed ({latest.error}). Scores below are from the last good run.</ErrorNote>
        </div>
      )}
      {ageHours > STALE_HOURS && latest?.status !== 'failed' && (
        <p className="mt-3 rounded-md bg-due-soft px-3 py-2 text-sm">
          These scores are more than a day old. Check that the nightly job is running.
        </p>
      )}
      <dl className="mt-4 grid gap-3 text-sm md:grid-cols-3">
        <ModelLine title="Late returns" m={good.metrics.late} what="a check-out that came back late" plural="late returns" />
        <ModelLine title="Losses" m={good.metrics.loss} what="a tool that went missing for a week" plural="losses" />
        <div>
          <dt className="font-semibold">Unusual check-outs: Isolation Forest</dt>
          <dd className="text-muted">
            Flags anything as unusual as the strangest {pct(good.metrics.anomaly?.flagFraction ?? 0.02)} of{' '}
            {good.metrics.anomaly?.trainedOn?.toLocaleString() ?? 0} past check-outs.
          </dd>
        </div>
      </dl>
    </Panel>
  );
}

/* ---------------------------------------------------------------- tools out */

function RiskLabel({ r, t }: { r: AtRiskCheckout; t: Insights['thresholds'] }) {
  const base = 'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-semibold';
  if (r.lateProbability === null) {
    return (
      <span className={`${base} text-muted ring-1 ring-inset ring-line`}>
        <CircleDashed className="size-4" aria-hidden /> Not scored yet
      </span>
    );
  }
  if (r.lossProbability! >= t.lossRisk) {
    return (
      <span className={`${base} bg-signal text-white`}>
        <ShieldAlert className="size-4" aria-hidden /> Loss risk {pct(r.lossProbability!)}
      </span>
    );
  }
  if (r.overdue) {
    return (
      <span className={`${base} bg-signal-soft text-ink ring-1 ring-inset ring-signal/40`}>
        <CircleAlert className="size-4 text-signal" aria-hidden /> Overdue
      </span>
    );
  }
  if (r.lateProbability >= t.likelyLate) {
    return (
      <span className={`${base} bg-due-soft text-ink ring-1 ring-inset ring-safety`}>
        <Clock className="size-4" aria-hidden /> Likely late, {pct(r.lateProbability)}
      </span>
    );
  }
  return (
    <span className={`${base} bg-ok-soft text-ink`}>
      <CircleCheck className="size-4 text-ok" aria-hidden /> On track, {pct(r.lateProbability)} late risk
    </span>
  );
}

function RiskRow({ r, t }: { r: AtRiskCheckout; t: Insights['thresholds'] }) {
  return (
    <li className="flex flex-col gap-2 px-4 py-4 md:flex-row md:items-start">
      <div className="min-w-0 flex-1">
        <Link href={`/tools/${r.toolId}`} className="flex flex-wrap items-center gap-2 font-semibold hover:underline">
          <AssetTag tag={r.assetTag} />
          <span className="min-w-0 truncate">{r.toolName}</span>
        </Link>
        <p className="mt-1 text-sm text-muted">
          {r.holderName}.{' '}
          <span className={r.overdue ? 'font-semibold text-signal' : ''}>
            {r.overdue ? 'Was due ' : 'Due '}
            {relative(r.dueBackAt)}
          </span>
          {r.offlineQueuedAt && (
            <span className="ml-2 inline-flex items-center gap-1">
              <CloudOff className="size-3.5" aria-hidden /> checked out offline
            </span>
          )}
        </p>
        {r.factors.length > 0 && (
          <p className="mt-1 text-sm">
            <span className="text-muted">Why: </span>
            {r.factors.map((f) => f.text).join(' · ')}
          </p>
        )}
      </div>
      <div className="shrink-0">
        <RiskLabel r={r} t={t} />
      </div>
    </li>
  );
}

/* ---------------------------------------------------------------- anomalies */

function AnomalyCard({ a, canReview }: { a: Anomaly; canReview: boolean }) {
  const review = useReviewAnomaly();
  const [note, setNote] = useState('');
  const decide = async (status: 'confirmed' | 'dismissed') => {
    try {
      await review.mutateAsync({ id: a.id, status, note: note.trim() || undefined });
      toast(status === 'dismissed' ? `${a.assetTag}: marked as fine` : `${a.assetTag}: marked for follow-up`);
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };
  const open = a.status === 'open';
  return (
    <li>
      <article
        aria-label={`Unusual check-out of ${a.assetTag}`}
        className={`rounded-lg border bg-panel p-4 ${open ? 'border-safety' : 'border-line'}`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <AssetTag tag={a.assetTag} />
          <Link href={`/tools/${a.toolId}`} className="font-semibold hover:underline">
            {a.toolName}
          </Link>
          <span className="text-sm text-muted">
            {a.holderName}, checked out {formatDateTime(a.checkedOutAt)}
            {a.returnedAt ? ', since returned' : ''}
          </span>
        </div>
        <ul className="mt-2 list-disc pl-5 text-sm">
          {a.reasons.map((r) => (
            <li key={r.key}>{r.text}</li>
          ))}
        </ul>
        {open ? (
          canReview && (
            <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3 sm:flex-row sm:items-end">
              <div className="flex-1">
                <Field label="Note (optional)" htmlFor={`note-${a.id}`}>
                  <Input
                    id={`note-${a.id}`}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={500}
                    placeholder="What did you find out?"
                  />
                </Field>
              </div>
              <div className="flex gap-2">
                <Button variant="quiet" busy={review.isPending} onClick={() => decide('dismissed')}>
                  Looks fine
                </Button>
                <Button variant="primary" busy={review.isPending} onClick={() => decide('confirmed')}>
                  Needs follow-up
                </Button>
              </div>
            </div>
          )
        ) : (
          <p className="mt-2 text-sm text-muted">
            {a.status === 'dismissed' ? 'Marked as fine' : 'Marked for follow-up'} by {a.reviewedByName}
            {a.reviewedAt ? `, ${relative(a.reviewedAt)}` : ''}
            {a.reviewNote ? `: “${a.reviewNote}”` : ''}
          </p>
        )}
      </article>
    </li>
  );
}
