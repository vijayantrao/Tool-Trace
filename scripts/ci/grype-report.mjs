#!/usr/bin/env node
/**
 * Turns a Grype JSON report into GitHub annotations and a job summary.
 * Critical findings with a fix available fail the build; high ones are warnings.
 *
 * Usage: node scripts/ci/grype-report.mjs grype.json "API image"
 */
import { appendFileSync, readFileSync } from 'node:fs';

const [file, label = 'image'] = process.argv.slice(2);
const report = JSON.parse(readFileSync(file, 'utf8'));
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
const ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3, Negligible: 4, Unknown: 5 };

const rows = (report.matches ?? [])
  .map((m) => ({
    severity: m.vulnerability.severity,
    id: m.vulnerability.id,
    pkg: m.artifact.name,
    version: m.artifact.version,
    type: m.artifact.type,
    fixedIn: (m.vulnerability.fix?.versions ?? []).join(', '),
    where: m.artifact.locations?.[0]?.path ?? '',
  }))
  .sort((a, b) => (ORDER[a.severity] ?? 9) - (ORDER[b.severity] ?? 9));

let critical = 0;
for (const r of rows) {
  if (r.severity !== 'Critical' && r.severity !== 'High') continue;
  if (r.severity === 'Critical') critical++;
  const level = r.severity === 'Critical' ? 'error' : 'warning';
  console.log(
    `::${level} title=${escProp(`${label}: ${r.id} in ${r.pkg}`)}::${esc(
      `${r.severity}: ${r.pkg} ${r.version} (${r.type}) at ${r.where}. Fixed in ${r.fixedIn || 'n/a'}.`,
    )}`,
  );
}

const counts = Object.entries(rows.reduce((acc, r) => ({ ...acc, [r.severity]: (acc[r.severity] ?? 0) + 1 }), {}))
  .map(([k, v]) => `${k}: ${v}`)
  .join(', ');
const summary = [
  `## Grype: ${label}`,
  '',
  rows.length === 0
    ? 'No fixable vulnerabilities.'
    : `${counts}\n\n| Severity | Vulnerability | Package | Installed | Fixed in |\n|---|---|---|---|---|\n` +
      rows.map((r) => `| ${r.severity} | ${r.id} | ${r.pkg} (${r.type}) | ${r.version} | ${r.fixedIn} |`).join('\n'),
  '',
].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);

if (critical > 0) {
  console.error(`${critical} critical vulnerabilities with a fix available in the ${label}.`);
  process.exit(1);
}
