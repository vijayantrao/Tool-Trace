#!/usr/bin/env node
/**
 * Turns an OWASP ZAP JSON report into GitHub annotations and a job summary.
 * High-risk alerts fail the build; medium/low/informational are reported as warnings/notices.
 *
 * Usage: node scripts/ci/zap-report.mjs zap/report.json
 */
import { appendFileSync, readFileSync } from 'node:fs';

const RISK = { 3: 'High', 2: 'Medium', 1: 'Low', 0: 'Informational' };
const clean = (s = '') =>
  String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
// Annotation values must not break the workflow-command syntax.
const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const alerts = (report.site ?? []).flatMap((site) => site.alerts ?? []);
alerts.sort((a, b) => Number(b.riskcode) - Number(a.riskcode));

const rows = [];
let high = 0;
for (const a of alerts) {
  const risk = Number(a.riskcode);
  const name = clean(a.name ?? a.alert);
  const urls = [...new Set((a.instances ?? []).map((i) => i.uri))];
  const text = `${RISK[risk]} (plugin ${a.pluginid}, CWE-${a.cweid}): ${clean(a.desc).slice(0, 300)} Seen at ${urls.length} URL(s), e.g. ${urls.slice(0, 3).join(' ')}`;
  const level = risk >= 3 ? 'error' : risk === 2 || risk === 1 ? 'warning' : 'notice';
  if (risk >= 3) high++;
  console.log(`::${level} title=${escProp(`ZAP: ${name}`)}::${esc(text)}`);
  rows.push(`| ${RISK[risk]} | ${name} | ${a.pluginid} | ${urls.length} |`);
}

const summary = [
  '## OWASP ZAP baseline',
  '',
  alerts.length === 0 ? 'No alerts.' : '| Risk | Alert | Rule | URLs |\n|---|---|---|---|\n' + rows.join('\n'),
  '',
].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);

if (high > 0) {
  console.error(`${high} high-risk alert(s).`);
  process.exit(1);
}
