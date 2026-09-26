#!/usr/bin/env node
/**
 * Prints a compact summary of the newest harness report as GitHub *annotations*.
 *
 * Why: report artifacts and job logs are not always reachable (and the publish
 * step is best-effort when another workflow is pushing at the same time), but
 * annotations can be read from the API for any run:
 *
 *   gh api repos/<owner>/<repo>/check-runs/<check-run-id>/annotations
 *
 * It never fails the step: evidence is better than a red X.
 *
 *   node loadtest/ci/summarize.mjs loadtest-results
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || 'loadtest-results';
const MAX_LINES = 8;

const note = (title, message) => {
  // Annotations are single line; %0A would be the escape, but keep it simple.
  console.log(`::notice title=${title}::${String(message).replace(/\s+/g, ' ').trim()}`);
};

function newestReport(directory, extension) {
  if (!fs.existsSync(directory)) return null;
  const files = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(extension))
    .map((name) => ({ name, at: fs.statSync(path.join(directory, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  return files.length ? path.join(directory, files[0].name) : null;
}

const fixed = (value, digits = 1) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'n/a';

const file = newestReport(dir, '.json');
if (!file) {
  note('loadtest', `no JSON report found in ${dir}`);
  process.exit(0);
}

/** @type {any} */
let report;
try {
  report = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (error) {
  note('loadtest', `could not parse ${file}: ${error.message}`);
  process.exit(0);
}

note('loadtest report', `${path.basename(file)} (${report.label} · ${report.profile} · auth=${report.authMode ?? 'none'})`);

const stages = [
  ...(report.latency?.stages ?? []),
  ...(report.load?.stages ?? []),
  ...(report.soak?.stages ?? []),
];

for (const stage of stages.slice(-MAX_LINES)) {
  const agg = stage.aggregate ?? {};
  note(
    `stage ${stage.label}`,
    `${agg.count ?? 0} reqs · ${fixed(stage.rps)} rps · ttfb p50 ${fixed(agg.ttfb?.p50)} ms · ` +
      `p95 ${fixed(agg.ttfb?.p95)} ms · max ${fixed(agg.ttfb?.max)} ms · problems ${agg.problemCount ?? 0}`,
  );
}

if (report.coldStart) {
  note(
    'cold start',
    `idle ${report.coldStart.sleepSeconds}s · first ttfb ${fixed(report.coldStart.firstTtfbMs)} ms · ` +
      `samples ${(report.coldStart.samples ?? []).map((s) => `${s.status}@${fixed(s.ttfbMs, 0)}ms`).join(', ')}`,
  );
}

const classes = {};
for (const failure of report.failures ?? []) {
  classes[failure.class] = (classes[failure.class] ?? 0) + 1;
}
const classSummary = Object.entries(classes)
  .map(([name, count]) => `${name}=${count}`)
  .join(' ');
note('problems', classSummary || 'none');

// db-traffic output, when the lab produced it.
const traffic = path.join(dir, 'db-traffic.txt');
if (fs.existsSync(traffic)) {
  const lines = fs
    .readFileSync(traffic, 'utf8')
    .split('\n')
    .filter((line) => /statements\/request/.test(line))
    .slice(0, MAX_LINES);
  if (lines.length) note('statements per request', lines.join(' | '));
}

const timeline = path.join(dir, 'db-timeline.txt');
if (fs.existsSync(timeline)) {
  const headline = fs
    .readFileSync(timeline, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('###'))
    .slice(0, MAX_LINES);
  if (headline.length) note('sql sequence', headline.join(' | '));
}
