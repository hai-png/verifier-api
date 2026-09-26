#!/usr/bin/env node
/**
 * verifier-api latency + load harness.
 *
 * Zero dependencies (node:http/https/dns only) so it runs anywhere:
 * a laptop, the Render container, or a GitHub runner.
 *
 *   node loadtest/run.mjs --base-url https://verify.noveld.com.et --profile latency
 *   node loadtest/run.mjs --base-url https://verify.noveld.com.et --profile load --concurrency 40
 *   node loadtest/run.mjs --base-url http://127.0.0.1:3001 --profile latency --api-key "$KEY"
 *
 * Exit code is 0 unless a budget (--budget-p95-ms / --budget-error-rate) fails.
 */
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { createClient, classify, PROBLEM_CLASSES } from './lib/http.mjs';
import { summarize, fixed, histogram } from './lib/stats.mjs';
import { resolveAuth, SCENARIOS, SAFE_DEFAULT_SCENARIOS, resolveScenarios } from './lib/scenarios.mjs';

const DEFAULTS = {
  profile: 'latency',
  iterations: 25,
  concurrency: 10,
  duration: 20,
  stages: '1:10,5:10,10:15,20:15,40:15',
  warmup: 3,
  maxTimeoutMs: 120_000,
  'auth-pace-rps': 0,
  'coldstart-sleep': 0,
  'coldstart-samples': 3,
};

function usage() {
  console.log(`Usage: node loadtest/run.mjs --base-url <url> [options]

Options:
  --base-url <url>          Target origin (required)
  --profile <name>          smoke | latency | load | soak | coldstart | all   (default: ${DEFAULTS.profile})
  --scenarios <list>        Comma separated scenario names, or "all" (default: anonymous set)
                            Available: ${Object.keys(SCENARIOS).join(', ')}
  --api-key <key>           API key for authenticated scenarios (needs DB access to mint)
  --api-key-env <VAR>       Read the API key from an environment variable instead
  --dashboard-secret <s>    DASHBOARD_SECRET of the target, used with --workspace-id
                            (alias: --dashboard-key)
  --dashboard-secret-env <VAR>
  --workspace-id <id>       Existing workspace id to attribute the run to
  --workspace-id-env <VAR>
  --auth-pace-rps <n>       Minimum requests/sec for authenticated scenarios in
                            the sequential profiles. A FREE workspace allows
                            config.freeRateLimit (10) requests per 60s window, so
                            an unpaced run measures the throttle path, not the
                            verification path.
  --allow-external          Permit scenarios that call third-party providers
  --concurrency <n>         Concurrent workers (load/soak)                  (default: ${DEFAULTS.concurrency})
  --duration <seconds>      Per-stage duration (load/soak)                  (default: ${DEFAULTS.duration})
  --iterations <n>          Sequential samples per scenario (latency/smoke) (default: ${DEFAULTS.iterations})
  --stages <c:d,...>        Ramp stages for the load profile               (default: ${DEFAULTS.stages})
  --warmup <n>              Discarded warm-up requests per scenario         (default: ${DEFAULTS.warmup})
  --max-timeout-ms <n>      Client-side request timeout                     (default: ${DEFAULTS.maxTimeoutMs})
  --coldstart-sleep <s>     Sleep before the cold-start probe (seconds)
  --coldstart-samples <n>   Cold-start probes to run
  --label <name>            Label written into the report
  --out-dir <dir>           Where JSON/Markdown reports are written         (default: loadtest-results)
  --budget-p95-ms <n>       Fail (exit 1) when aggregate p95 exceeds this
  --budget-error-rate <r>   Fail (exit 1) when the error rate exceeds this (0..1)
  --help
`);
}

function parseCli() {
  const { values } = parseArgs({
    options: {
      'base-url': { type: 'string' },
      profile: { type: 'string' },
      scenarios: { type: 'string' },
      'api-key': { type: 'string' },
      'api-key-env': { type: 'string' },
      'dashboard-secret': { type: 'string' },
      'dashboard-key': { type: 'string' },
      'dashboard-secret-env': { type: 'string' },
      'workspace-id': { type: 'string' },
      'workspace-id-env': { type: 'string' },
      'auth-pace-rps': { type: 'string' },
      'allow-external': { type: 'boolean', default: false },
      concurrency: { type: 'string' },
      duration: { type: 'string' },
      iterations: { type: 'string' },
      stages: { type: 'string' },
      warmup: { type: 'string' },
      'max-timeout-ms': { type: 'string' },
      'coldstart-sleep': { type: 'string' },
      'coldstart-samples': { type: 'string' },
      label: { type: 'string' },
      'out-dir': { type: 'string' },
      'budget-p95-ms': { type: 'string' },
      'budget-error-rate': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    usage();
    process.exit(0);
  }
  const num = (key, fallback) => {
    const raw = values[key];
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new Error(`--${key} must be a number`);
    return parsed;
  };
  const baseUrl = values['base-url'] || process.env.LOADTEST_BASE_URL;
  if (!baseUrl) {
    usage();
    throw new Error('--base-url is required (or set LOADTEST_BASE_URL)');
  }
  const fromEnv = (directKey, envKey, label) => {
    const direct = values[directKey] || null;
    if (direct) return direct;
    if (!values[envKey]) return null;
    const value = process.env[values[envKey]] || null;
    if (!value) {
      console.error(`warning: ${values[envKey]} is not set — ${label} scenarios will be skipped`);
    }
    return value;
  };
  const auth = resolveAuth({
    apiKey: fromEnv('api-key', 'api-key-env', 'authenticated'),
    dashboardKey:
      values['dashboard-secret'] ||
      values['dashboard-key'] ||
      fromEnv('dashboard-secret', 'dashboard-secret-env', 'authenticated'),
    workspaceId: (values['workspace-id'] || (values['workspace-id-env'] && process.env[values['workspace-id-env']]) || null),
  });
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    profile: values.profile || DEFAULTS.profile,
    scenarios: values.scenarios,
    auth,
    allowExternal: values['allow-external'],
    concurrency: num('concurrency', DEFAULTS.concurrency),
    duration: num('duration', DEFAULTS.duration),
    iterations: num('iterations', DEFAULTS.iterations),
    stages: values.stages || DEFAULTS.stages,
    warmup: num('warmup', DEFAULTS.warmup),
    maxTimeoutMs: num('max-timeout-ms', DEFAULTS.maxTimeoutMs),
    authPaceRps: num('auth-pace-rps', DEFAULTS['auth-pace-rps']),
    coldstartSleep: num('coldstart-sleep', DEFAULTS['coldstart-sleep']),
    coldstartSamples: num('coldstart-samples', DEFAULTS['coldstart-samples']),
    label: values.label || 'verifier-api',
    outDir: values['out-dir'] || 'loadtest-results',
    budgetP95: values['budget-p95-ms'] === undefined ? null : num('budget-p95-ms', null),
    budgetErrorRate: values['budget-error-rate'] === undefined ? null : num('budget-error-rate', null),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A run can be perfectly healthy and still measure the wrong thing: if the
 * server rejects the credentials, every "authenticated" sample is a 401/403/404
 * and the report would look like a fast, error-free verification path. Say so
 * explicitly, with the likely cause, instead of leaving it to the reader.
 */
function credentialHint(report, targets) {
  const authenticated = new Set(
    targets.filter((t) => t.scenario.group === 'authenticated' && !t.scenario.external && t.name !== 'permissions_403').map((t) => t.name),
  );
  if (!report.authenticated || authenticated.size === 0) return null;

  const seen = new Map();
  for (const section of [report.latency, report.load, report.soak]) {
    for (const stage of section?.stages ?? []) {
      for (const [name, agg] of Object.entries(stage.byScenario ?? {})) {
        if (!authenticated.has(name)) continue;
        const classes = seen.get(name) ?? new Set();
        for (const klass of Object.keys(agg.responseClasses ?? agg.classes ?? {})) classes.add(klass);
        seen.set(name, classes);
      }
    }
  }
  if (seen.size === 0) return null;

  const rejected = new Set(['unauthenticated_401', 'forbidden_403', 'not_found_404']);
  const all = [...seen.values()];
  if (!all.every((classes) => [...classes].length > 0 && [...classes].every((c) => rejected.has(c)))) {
    return null;
  }

  const classes = new Set(all.flatMap((set) => [...set]));
  if (classes.has('unauthenticated_401')) {
    return report.authMode === 'dashboard-secret'
      ? "every authenticated scenario returned 401: the target ignored x-dashboard-key, so its DASHBOARD_SECRET does not match the LOADTEST_DASHBOARD_SECRET secret (or is unset on the service)."
      : "every authenticated scenario returned 401: the target ignored x-api-key. Check that the key exists on *this* deployment and is still active.";
  }
  if (classes.has('not_found_404') && report.authMode === 'dashboard-secret') {
    return 'every authenticated scenario returned 404: LOADTEST_WORKSPACE_ID does not exist in the target database.';
  }
  if (classes.has('forbidden_403')) {
    return 'every authenticated scenario returned 403: the credentials are recognised but rejected (inactive key, or the workspace does not belong to this key).';
  }
  return null;
}

/**
 * Throttle authenticated requests to `rps` so a sequential profile stays inside
 * the workspace rate limit instead of measuring 429 responses. Anonymous
 * scenarios are never paced.
 */
function createAuthPacer({ rps, targets }) {
  const pacedScenarios = new Set(
    targets.filter((t) => t.scenario.group === 'authenticated').map((t) => t.name),
  );
  if (!(rps > 0) || pacedScenarios.size === 0) {
    return { enabled: false, pacedScenarios: [...pacedScenarios], wait: async () => {} };
  }
  const intervalMs = 1000 / rps;
  let nextSlotAt = 0;
  return {
    enabled: true,
    pacedScenarios: [...pacedScenarios],
    wait: async (taskName) => {
      if (!pacedScenarios.has(taskName)) return;
      const waitMs = nextSlotAt - Date.now();
      if (waitMs > 0) await sleep(waitMs);
      nextSlotAt = Math.max(Date.now(), nextSlotAt) + intervalMs;
    },
  };
}

function buildTask(name, ctx) {
  const scenario = SCENARIOS[name];
  if (scenario.group === 'authenticated' && !ctx.auth) {
    return null;
  }
  return { name, scenario, get descriptor() { return scenario.request(ctx); } };
}

function recordSample(store, name, result, startedAtMs) {
  const expected = SCENARIOS[name]?.expectedStatuses;
  const klass = expected && !result.error && !expected.includes(result.status)
    && result.status < 500 && ![402, 429].includes(result.status)
    ? 'unexpected_status' : classify(result);
  const sample = {
    scenario: name,
    status: result.status,
    class: klass,
    responseClass: classify(result),
    ttfbMs: result.ttfbMs,
    totalMs: result.totalMs,
    connectMs: result.connectMs,
    tlsMs: result.tlsMs,
    reused: result.reusedConnection,
    error: result.error,
    bodySnippet: result.bodySnippet ? result.bodySnippet.slice(0, 300) : null,
    startedAtMs,
  };
  store.samples.push(sample);
  if (!store.byScenario[name]) store.byScenario[name] = [];
  store.byScenario[name].push(sample);
  // Only transport failures, 5xx and 503s count as problems. 4xx responses are
  // expected outcomes for several scenarios (401/403/402 probing) and are
  // reported as classes instead.
  if (PROBLEM_CLASSES.has(klass)) {
    store.problems.push(sample);
  }
  return sample;
}

/** Sequential (concurrency = 1) latency measurement — the clean warm baseline. */
async function runLatency({ client, targets, iterations, warmup, timeoutMs, pacer }) {
  const store = { samples: [], byScenario: {}, problems: [], warmup: [], durationMs: 0 };
  for (const task of targets) {
    for (let i = 0; i < warmup; i += 1) {
      await pacer.wait(task.name);
      const result = await client.request({ ...task.descriptor, label: task.name, timeout: timeoutMs });
      store.warmup.push(recordSample({ samples: [], byScenario: {}, problems: [] }, task.name, result, 0));
    }
    const measuredAt = Date.now();
    for (let i = 0; i < iterations; i += 1) {
      await pacer.wait(task.name);
      const result = await client.request({ ...task.descriptor, label: task.name, timeout: timeoutMs });
      recordSample(store, task.name, result, i);
    }
    store.durationMs += Date.now() - measuredAt;
  }
  return store;
}

/** Closed-loop load: `concurrency` workers hammer the scenario ring for `durationMs`. */
async function runStage({ client, targets, concurrency, durationMs, timeoutMs, stageLabel }) {
  const store = { samples: [], byScenario: {}, problems: [], stage: stageLabel };
  const startedAt = Date.now();
  const deadline = startedAt + durationMs;

  const worker = async (workerIndex) => {
    let index = workerIndex;
    while (Date.now() < deadline) {
      const task = targets[index % targets.length];
      index += 1;
      const beganAt = Date.now() - startedAt;
      const result = await client.request({ ...task.descriptor, label: task.name, timeout: timeoutMs });
      recordSample(store, task.name, result, beganAt);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
  store.durationMs = Date.now() - startedAt;
  return store;
}

function aggregate(samples) {
  const ttfb = summarize(samples.map((s) => s.ttfbMs));
  const total = summarize(samples.map((s) => s.totalMs));
  const classes = {};
  const responseClasses = {};
  for (const sample of samples) {
    const responseClass = sample.responseClass ?? sample.class;
    responseClasses[responseClass] = (responseClasses[responseClass] || 0) + 1;
    classes[sample.class] = (classes[sample.class] || 0) + 1;
  }
  const problems = samples.filter((s) => PROBLEM_CLASSES.has(s.class));
  return {
    count: samples.length,
    ttfb,
    total,
    classes,
    responseClasses,
    problemCount: problems.length,
    errorRate: samples.length ? problems.length / samples.length : 0,
  };
}

function perSecondTimeline(samples, startedAtMs) {
  const buckets = new Map();
  for (const sample of samples) {
    const second = Math.floor((sample.startedAtMs || 0) / 1000);
    if (!buckets.has(second)) buckets.set(second, []);
    buckets.get(second).push(sample);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([second, bucket]) => ({
      second,
      count: bucket.length,
      p95: summarize(bucket.map((s) => s.totalMs)).p95,
      problems: bucket.filter((s) => PROBLEM_CLASSES.has(s.class)).length,
    }));
}

function markdownReport(report) {
  const lines = [];
  lines.push(`# Load test report — ${report.label}`);
  lines.push('');
  lines.push(`- **Target:** \`${report.baseUrl}\``);
  lines.push(`- **Run at:** ${report.startedAt}`);
  lines.push(`- **Profile:** \`${report.profile}\``);
  lines.push(`- **Scenarios:** ${report.scenarios.join(', ')}`);
  lines.push(`- **Authenticated:** ${report.authenticated ? `yes (${report.authMode})` : 'no'}`);
  if (report.authHint) lines.push(`- **⚠️ Credentials rejected:** ${report.authHint}`);
  lines.push(`- **Runtime:** Node ${report.node}, ${report.platform}, ${report.cpuCount} vCPU`);
  if (report.dns) {
    lines.push(`- **Resolved:** ${report.dns.addresses.join(', ') || 'n/a'}${report.dns.cname ? ` (CNAME ${report.dns.cname})` : ''}`);
  }
  lines.push(`- **Client:** keep-alive, max ${report.maxSockets} sockets; connections created ${report.connections.created}, reused ${report.connections.reused}`);
  if (report.authPaceRps) {
    lines.push(`- **Authenticated pacing:** ${report.authPaceRps} req/s (stays inside the workspace rate limit — see loadtest/README.md)`);
  }
  lines.push('');

  if (report.coldStart) {
    lines.push('## Cold start / wake-up probe');
    lines.push('');
    lines.push('| # | Status | TTFB (ms) | Total (ms) | Result |');
    lines.push('|---|--------|-----------|------------|--------|');
    report.coldStart.samples.forEach((sample, index) => {
      lines.push(`| ${index + 1} | ${sample.status ?? '—'} | ${fixed(sample.ttfbMs)} | ${fixed(sample.totalMs)} | ${sample.class} |`);
    });
    lines.push('');
    lines.push(`Sleep before probe: ${report.coldStart.sleepSeconds}s. First-request TTFB: **${fixed(report.coldStart.firstTtfbMs)} ms**.`);
    lines.push('');
  }

  const sections = [
    ['Latency (sequential, warm)', report.latency],
    ['Load stages', report.load],
    ['Soak', report.soak],
  ];
  for (const [title, section] of sections) {
    if (!section) continue;
    lines.push(`## ${title}`);
    lines.push('');
    if (section.stages.length === 0) {
      lines.push('_no data_');
      lines.push('');
      continue;
    }
    lines.push('| Stage | Requests | RPS | TTFB p50 | TTFB p95 | Total p50 | Total p95 | Total p99 | Max | 2xx | 4xx | 429 | 5xx | Errors |');
    lines.push('|-------|----------|-----|----------|----------|-----------|-----------|-----------|-----|-----|-----|-----|-----|--------|');
    for (const stage of section.stages) {
      const c = stage.aggregate.classes;
      const c4xx = Object.entries(c).filter(([k]) => k.endsWith('_4xx') || k.endsWith('_401') || k.endsWith('_403') || k.endsWith('_404')).reduce((a, [, v]) => a + v, 0);
      lines.push([
        `| ${stage.label}`,
        stage.aggregate.count,
        fixed(stage.rps, 1),
        fixed(stage.aggregate.ttfb.p50),
        fixed(stage.aggregate.ttfb.p95),
        fixed(stage.aggregate.total.p50),
        fixed(stage.aggregate.total.p95),
        fixed(stage.aggregate.total.p99),
        fixed(stage.aggregate.total.max),
        stage.aggregate.classes.ok || 0,
        c4xx,
        c.throttled_429 || 0,
        c.server_error_5xx || 0,
        stage.aggregate.problemCount,
      ].join(' | '));
    }
    lines.push('');
    for (const stage of section.stages) {
      if (!stage.byScenario || Object.keys(stage.byScenario).length <= 1) continue;
      lines.push(`### ${stage.label} — per scenario`);
      lines.push('');
      lines.push('| Scenario | Requests | TTFB p50 | TTFB p95 | Total p50 | Total p95 | Total p99 | Errors |');
      lines.push('|----------|----------|----------|----------|-----------|-----------|-----------|--------|');
      for (const [name, agg] of Object.entries(stage.byScenario)) {
        lines.push(`| ${name} | ${agg.count} | ${fixed(agg.ttfb.p50)} | ${fixed(agg.ttfb.p95)} | ${fixed(agg.total.p50)} | ${fixed(agg.total.p95)} | ${fixed(agg.total.p99)} | ${agg.problemCount} |`);
      }
      lines.push('');
    }
    if (section.timeline && section.timeline.length) {
      lines.push(`### ${title} — throughput per second`);
      lines.push('');
      lines.push('```');
      for (const tick of section.timeline) {
        const bar = '█'.repeat(Math.min(60, Math.round(tick.count / 2) || 0));
        lines.push(`${String(tick.second).padStart(3, ' ')}s rps=${String(tick.count).padStart(4)} p95=${String(Math.round(tick.p95 ?? 0)).padStart(6)}ms err=${tick.problems} ${bar}`);
      }
      lines.push('```');
      lines.push('');
    }
  }

  if (report.failures.length) {
    lines.push('## Failure samples');
    lines.push('');
    lines.push('| Scenario | Status | Class | Total (ms) | Snippet |');
    lines.push('|----------|--------|-------|------------|---------|');
    for (const failure of report.failures.slice(0, 20)) {
      lines.push(`| ${failure.scenario} | ${failure.status ?? '—'} | ${failure.class} | ${fixed(failure.totalMs)} | ${(failure.bodySnippet || failure.error || '').replace(/\|/g, '\\|').slice(0, 120)} |`);
    }
    lines.push('');
  }

  if (report.budgets) {
    lines.push('## Budgets');
    lines.push('');
    for (const budget of report.budgets) {
      lines.push(`- ${budget.passed ? '✅' : '❌'} ${budget.name}: ${budget.detail}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function consoleSummary(report) {
  console.log('');
  console.log(`target        ${report.baseUrl}`);
  console.log(`resolved      ${(report.dns?.addresses || []).join(', ')}${report.dns?.cname ? `  cname=${report.dns.cname}` : ''}`);
  console.log(`profile       ${report.profile}`);
  console.log(`connections   created=${report.connections.created} reused=${report.connections.reused}`);
  if (report.coldStart) {
    console.log(`cold start    first TTFB ${fixed(report.coldStart.firstTtfbMs)} ms (sleep ${report.coldStart.sleepSeconds}s)`);
  }
  const rows = [];
  for (const stage of (report.latency?.stages || [])) rows.push(stage);
  for (const stage of (report.load?.stages || [])) rows.push(stage);
  for (const stage of (report.soak?.stages || [])) rows.push(stage);
  if (rows.length) {
    console.log('');
    console.log(['stage'.padEnd(18), 'reqs'.padStart(6), 'rps'.padStart(7), 'p50'.padStart(8), 'p95'.padStart(8), 'p99'.padStart(8), 'max'.padStart(9), 'err'.padStart(5)].join(' '));
    for (const stage of rows) {
      const agg = stage.aggregate;
      console.log([
        String(stage.label).padEnd(18),
        String(agg.count).padStart(6),
        fixed(stage.rps, 1).padStart(7),
        fixed(agg.total.p50).padStart(8),
        fixed(agg.total.p95).padStart(8),
        fixed(agg.total.p99).padStart(8),
        fixed(agg.total.max).padStart(9),
        String(agg.problemCount).padStart(5),
      ].join(' '));
    }
  }
  if (report.failures.length) {
    console.log('');
    console.log('failure classes:');
    const counts = {};
    for (const failure of report.failures) counts[failure.class] = (counts[failure.class] || 0) + 1;
    for (const [klass, count] of Object.entries(counts)) console.log(`  ${klass}: ${count}`);
  }
}

async function main() {
  const options = parseCli();
  const positive = ['concurrency', 'duration', 'iterations', 'maxTimeoutMs', 'coldstartSamples'];
  for (const key of positive) if (!(options[key] > 0)) throw new Error(`${key} must be positive`);
  for (const key of ['concurrency', 'iterations', 'warmup', 'coldstartSamples']) {
    if (!Number.isInteger(options[key]) || options[key] < 0) throw new Error(`${key} must be a nonnegative integer`);
  }
  for (const key of ['authPaceRps', 'coldstartSleep']) if (options[key] < 0) throw new Error(`${key} must be nonnegative`);
  if (!['smoke', 'latency', 'load', 'soak', 'coldstart', 'all'].includes(options.profile)) throw new Error('Unknown profile');
  if (!options.stages.split(',').every((s) => /^\d+:(?:\d+(?:\.\d+)?|\.\d+)$/.test(s) && s.split(':').every((n) => Number(n) > 0))) throw new Error('Invalid stages; use positive concurrency:seconds pairs');
  if (options.budgetErrorRate !== null && (options.budgetErrorRate < 0 || options.budgetErrorRate > 1)) throw new Error('Error budget must be between 0 and 1');
  if (options.budgetP95 !== null && options.budgetP95 <= 0) throw new Error('Latency budget must be positive');
  const startedAt = new Date();

  let dnsInfo = null;
  try {
    const { hostname } = new URL(options.baseUrl);
    const addresses = await dns.lookup(hostname, { all: true });
    let cname = null;
    try {
      const cnames = await dns.resolveCname(hostname);
      cname = cnames[0] || null;
    } catch { /* not a CNAME */ }
    dnsInfo = { hostname, addresses: addresses.map((a) => `${a.address} (${a.family})`), cname };
  } catch (error) {
    dnsInfo = { hostname: new URL(options.baseUrl).hostname, addresses: [], cname: null, error: error.message };
  }

  const names = resolveScenarios(
    options.scenarios ? options.scenarios.split(',').map((s) => s.trim()).filter(Boolean) : null,
    { allowExternal: options.allowExternal },
  );

  const client = createClient({ baseUrl: options.baseUrl, maxSockets: 128, timeoutMs: options.maxTimeoutMs });
  const ctx = { auth: options.auth, apiKey: options.auth?.mode === 'api-key' ? options.auth.headers['x-api-key'] : null };

  const targets = [];
  const skipped = [];
  for (const name of names) {
    const task = buildTask(name, ctx);
    if (task) targets.push(task);
    else skipped.push(name);
  }
  if (skipped.length) {
    console.error(`warning: skipping authenticated scenarios (no credentials): ${skipped.join(', ')}`);
    console.error('         pass --api-key, or --dashboard-secret + --workspace-id for the dashboard path');
  }
  if (targets.length === 0) {
    throw new Error('No runnable scenarios. Provide --api-key or --dashboard-secret + --workspace-id.');
  }

  const pacer = createAuthPacer({ rps: options.authPaceRps, targets });

  /** @type {any} */
  const report = {
    label: options.label,
    workflowRunId: process.env.GITHUB_RUN_ID ?? null,
    baseUrl: options.baseUrl,
    startedAt: startedAt.toISOString(),
    profile: options.profile,
    scenarios: targets.map((t) => t.name),
    skippedScenarios: skipped,
    authenticated: Boolean(options.auth),
    authMode: options.auth?.mode ?? null,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    cpuCount: (await import('node:os')).cpus().length,
    maxSockets: 128,
    authPaceRps: pacer.enabled ? options.authPaceRps : null,
    dns: dnsInfo,
    connections: { created: 0, reused: 0 },
    coldStart: null,
    latency: null,
    load: null,
    soak: null,
    failures: [],
    budgets: null,
  };

  const profiles = options.profile === 'all'
    ? ['coldstart', 'latency', 'load']
    : [options.profile];

  for (const profile of profiles) {
    if (profile === 'coldstart') {
      if (options.coldstartSleep > 0) {
        console.log(`sleeping ${options.coldstartSleep}s before the cold-start probe (letting the free tier idle out)…`);
        await sleep(options.coldstartSleep * 1000);
      }
      const samples = [];
      for (let i = 0; i < options.coldstartSamples; i += 1) {
        const before = Date.now();
        const result = await client.request({
          ...targets.find((t) => t.name === 'ready')?.descriptor ?? { method: 'GET', path: '/ready' },
          label: 'coldstart',
          timeout: options.maxTimeoutMs,
        });
        samples.push(recordSample({ samples: [], byScenario: {}, problems: [] }, 'coldstart', result, 0));
        if (i === 0) report.coldStartIdleMs = Date.now() - before;
      }
      report.coldStart = {
        sleepSeconds: options.coldstartSleep,
        samples: samples.map((s) => ({ status: s.status, class: s.class, ttfbMs: s.ttfbMs, totalMs: s.totalMs })),
        firstTtfbMs: samples[0]?.ttfbMs ?? null,
      };
      report.failures.push(...samples.filter((s) => PROBLEM_CLASSES.has(s.class)));
    }

    if (profile === 'smoke' || profile === 'latency') {
      const store = await runLatency({
        client,
        targets,
        iterations: profile === 'smoke' ? 1 : options.iterations,
        warmup: profile === 'smoke' ? 0 : options.warmup,
        timeoutMs: options.maxTimeoutMs,
        pacer,
      });
      const agg = aggregate(store.samples);
      report.latency = {
        stages: [{
          label: profile === 'smoke' ? 'smoke (1 each)' : `sequential ×${options.iterations}`,
          aggregate: agg,
          rps: agg.count / (store.durationMs / 1000 || 1),
          byScenario: Object.fromEntries(Object.entries(store.byScenario).map(([name, samples]) => [name, aggregate(samples)])),
        }],
        timeline: [],
      };
      report.failures.push(...store.problems);
    }

    if (profile === 'load') {
      const stages = options.stages.split(',').map((chunk) => {
        const [concurrency, duration] = chunk.split(':').map(Number);
        return { concurrency, duration };
      });
      const allSamples = [];
      const stageReports = [];
      let timelineOffsetMs = 0;
      for (const stage of stages) {
        console.log(`stage: ${stage.concurrency} concurrent × ${stage.duration}s …`);
        const store = await runStage({
          client,
          targets,
          concurrency: stage.concurrency,
          durationMs: stage.duration * 1000,
          timeoutMs: options.maxTimeoutMs,
          stageLabel: `c=${stage.concurrency}`,
        });
        const agg = aggregate(store.samples);
        const rps = store.samples.length / (store.durationMs / 1000);
        stageReports.push({
          label: `c=${stage.concurrency}`,
          aggregate: agg,
          rps,
          byScenario: Object.fromEntries(Object.entries(store.byScenario).map(([name, samples]) => [name, aggregate(samples)])),
        });
        report.failures.push(...store.problems);
        allSamples.push(...store.samples.map((sample) => ({ ...sample, startedAtMs: sample.startedAtMs + timelineOffsetMs })));
        timelineOffsetMs += store.durationMs;
        console.log(`  ${store.samples.length} requests, ${fixed(rps, 1)} rps, p95 ${fixed(agg.total.p95)} ms, problems ${agg.problemCount}`);
      }
      report.load = { stages: stageReports, timeline: perSecondTimeline(allSamples) };
    }

    if (profile === 'soak') {
      console.log(`soak: ${options.concurrency} concurrent × ${options.duration}s …`);
      const store = await runStage({
        client,
        targets,
        concurrency: options.concurrency,
        durationMs: options.duration * 1000,
        timeoutMs: options.maxTimeoutMs,
        stageLabel: `soak c=${options.concurrency}`,
      });
      const agg = aggregate(store.samples);
      report.soak = {
        stages: [{
          label: `soak c=${options.concurrency}`,
          aggregate: agg,
          rps: store.samples.length / (store.durationMs / 1000),
          byScenario: Object.fromEntries(Object.entries(store.byScenario).map(([name, samples]) => [name, aggregate(samples)])),
        }],
        timeline: perSecondTimeline(store.samples),
      };
      report.failures.push(...store.problems);
    }
  }

  report.connections = client.stats();
  report.authHint = credentialHint(report, targets);
  if (report.authHint) console.error(`warning: ${report.authHint}`);
  const os = await import('node:os');
  report.memory = {
    peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
    freeMemMb: Math.round(os.freemem() / 1024 / 1024),
  };

  // ── Budgets ────────────────────────────────────────────────────────────────
  // The load profile is judged on its highest stage; latency-only runs are
  // judged on their single sequential stage.
  const mainStage = report.load?.stages?.at(-1) || report.latency?.stages?.at(0) || report.soak?.stages?.at(0);
  const budgets = [{
    name: 'valid measurement',
    passed: !report.authHint && (mainStage ? mainStage.aggregate.count > 0 && mainStage.aggregate.problemCount < mainStage.aggregate.count : report.coldStart?.samples.some((s) => !PROBLEM_CLASSES.has(s.class))),
    detail: report.authHint || 'At least one non-failing measured response is required; all-failure runs cannot pass.',
  }];
  if (mainStage) {
    if (options.budgetP95 !== null) {
      const p95 = mainStage.aggregate.total.p95;
      budgets.push({
        name: 'p95 latency',
        passed: p95 !== null && p95 <= options.budgetP95,
        detail: `${fixed(p95)} ms (budget ${options.budgetP95} ms) on ${mainStage.label}`,
      });
    }
    if (options.budgetErrorRate !== null) {
      const rate = mainStage.aggregate.errorRate;
      budgets.push({
        name: 'error rate',
        passed: rate <= options.budgetErrorRate,
        detail: `${(rate * 100).toFixed(2)}% (budget ${(options.budgetErrorRate * 100).toFixed(2)}%) on ${mainStage.label}`,
      });
    }
  }
  budgets.push({
    name: 'scenario contracts',
    passed: !report.failures.some((s) => s.class === 'unexpected_status'),
    detail: 'Unexpected endpoint status codes invalidate the run, independently of transport budgets.',
  });
  report.budgets = budgets;

  // ── Persist ────────────────────────────────────────────────────────────────
  fs.mkdirSync(options.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${options.label}-${options.profile}-${stamp}`;
  const jsonPath = path.join(options.outDir, `${base}.json`);
  const mdPath = path.join(options.outDir, `${base}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = markdownReport(report);
  fs.writeFileSync(mdPath, `${markdown}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }

  consoleSummary(report);
  console.log('');
  console.log(`report  ${mdPath}`);
  console.log(`json    ${jsonPath}`);

  client.close();

  const failed = (report.budgets || []).filter((b) => !b.passed);
  if (failed.length) {
    console.error('');
    for (const budget of failed) console.error(`budget failed — ${budget.name}: ${budget.detail}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 2;
});
