#!/usr/bin/env node
/**
 * Grant or revoke unlimited credits — and, in the same call, change plan — for
 * one or more workspaces.
 *
 * Unlimited is a boolean on the workspace, not a big number in the credit
 * columns: the monthly reset overwrites those counters with the plan allowance,
 * so a sentinel like 999999 would be wiped every 30 days. The flag is also
 * honoured by skipping the gates and the decrements outright, so nothing is
 * left to read back as a misleading balance.
 *
 *   node scripts/grant-unlimited.mjs ws_abc ws_def
 *   node scripts/grant-unlimited.mjs --verify-only ws_abc
 *   node scripts/grant-unlimited.mjs --images-only ws_abc
 *   node scripts/grant-unlimited.mjs --revoke ws_abc
 *   node scripts/grant-unlimited.mjs --tier PRO --months 12 ws_abc
 *   node scripts/grant-unlimited.mjs --tier BUSINESS --plan-only ws_abc
 *
 * The full upgrade a paying customer gets is one command:
 *
 *   node scripts/grant-unlimited.mjs --tier PRO --months 12 ws_abc
 *
 * which sets the tier, the term, and both unlimited flags. The tier change
 * applies the new plan's allowance immediately (the admin endpoint tops the
 * balance up to the new quota; see POST /admin/workspaces/plan).
 *
 * For the common FREE -> PRO upgrade there is a dedicated wrapper with the
 * tier filled in: scripts/upgrade-to-pro.mjs.
 *
 * Environment:
 *   ADMIN_SECRET   required. The same value the API is configured with.
 *   SMOKE_API_URL  optional. Defaults to the production API.
 *
 * Reads ADMIN_SECRET from the environment rather than argv, so it does not land
 * in shell history or in the process list.
 */

import { pathToFileURL } from 'node:url';

const API_URL = (process.env.SMOKE_API_URL || 'https://verify.noveld.com.et').replace(/\/$/, '');
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const TIERS = ['FREE', 'PRO', 'BUSINESS'];

function parseArgs(argv) {
  const options = { verifications: true, images: true, revoke: false, planOnly: false, tier: null, months: null };
  const ids = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--verify-only') options.images = false;
    else if (arg === '--images-only') options.verifications = false;
    else if (arg === '--revoke') options.revoke = true;
    else if (arg === '--plan-only') options.planOnly = true;
    else if (arg === '--tier') options.tier = (argv[++i] ?? '').toUpperCase();
    else if (arg === '--months') options.months = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else ids.push(arg);
  }
  return { ...options, ids };
}

function usage() {
  console.log(`Grant or revoke unlimited credits, optionally with a plan change.

Usage:
  node scripts/grant-unlimited.mjs <workspace-id> [more ids...]
  node scripts/grant-unlimited.mjs --verify-only <id>        unlimited verifications only
  node scripts/grant-unlimited.mjs --images-only <id>        unlimited image credits only
  node scripts/grant-unlimited.mjs --revoke <id>             revoke both
  node scripts/grant-unlimited.mjs --tier <tier> [--months <n>] <id>
                                                             also set the plan (and term)
  node scripts/grant-unlimited.mjs --tier <tier> --plan-only <id>
                                                             plan change only, leave the
                                                             unlimited flags untouched
  node scripts/grant-unlimited.mjs --help

Tiers:      FREE, PRO, BUSINESS
Months:     0-120. 0 clears the term (no auto-downgrade date).

A tier change applies the new plan's allowance immediately — the workspace can
use the new quota on its next request, not at the next monthly reset.

Environment:
  ADMIN_SECRET   required — the API's ADMIN_SECRET
  SMOKE_API_URL  optional — defaults to ${API_URL}

Unlimited grants persist across the monthly credit reset and a plan downgrade.
To confirm afterwards, read the flags from GET /workspaces/<id>.`);
}

/**
 * fetch with a timeout.
 *
 * Deliberately not AbortSignal.timeout(): that leaves a timer pending, and an
 * explicit process.exit() after a fetch tears down a live libuv handle and
 * asserts on Windows — "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
 * file src\\win\\async.c". So: clear the timer in finally, and set exitCode
 * instead of exiting.
 */
async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a grant. Returns the process exit code instead of setting it, so
 * scripts/upgrade-to-pro.mjs can call this in-process — a child process would
 * lose the shared fetch/error handling and duplicate the argument rules.
 * `scriptName` only affects the audit note, so the trail names the command the
 * operator actually ran.
 */
async function main(argv = process.argv.slice(2), { scriptName = 'grant-unlimited' } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    usage();
    return 2;
  }

  if (options.help) { usage(); return 0; }
  if (!ADMIN_SECRET) {
    console.error('ADMIN_SECRET is not set. Nothing was sent.');
    console.error('PowerShell:  $env:ADMIN_SECRET = "..."');
    return 2;
  }
  if (options.ids.length === 0) {
    console.error('At least one workspace id is required.');
    usage();
    return 2;
  }
  if (options.revoke && !(options.verifications && options.images)) {
    console.error('--revoke cannot be combined with --verify-only or --images-only.');
    return 2;
  }
  if (options.tier !== null && !TIERS.includes(options.tier)) {
    console.error(`--tier must be one of: ${TIERS.join(', ')}.`);
    return 2;
  }
  if (options.months !== null && (!Number.isInteger(options.months) || options.months < 0 || options.months > 120)) {
    console.error('--months must be an integer between 0 and 120.');
    return 2;
  }
  const planChange = options.tier !== null || options.months !== null;
  if (options.planOnly && !planChange) {
    console.error('--plan-only requires --tier and/or --months — otherwise there is nothing to change.');
    return 2;
  }
  // Contradictory combinations are refused rather than guessed at: --plan-only
  // promises the flags are untouched, and --revoke/--verify-only/--images-only
  // exist to touch them.
  if (options.planOnly && (options.revoke || !options.verifications || !options.images)) {
    console.error('--plan-only cannot be combined with --revoke, --verify-only or --images-only.');
    return 2;
  }

  const note = options.revoke
    ? `revoked via ${scriptName} script`
    : planChange
      ? `plan grant via ${scriptName} script (${options.tier ?? 'tier unchanged'}${options.months !== null ? `, ${options.months} month(s)` : ''})`
      : `granted via ${scriptName} script`;

  const body = {
    workspaceIds: options.ids,
    note,
  };
  if (planChange) {
    if (options.tier !== null) body.tier = options.tier;
    if (options.months !== null) body.planTermMonths = options.months;
  }
  // Only send the flags this invocation actually touches, so a --verify-only
  // call cannot revoke an unrelated image grant by leaving it undefined — and a
  // --plan-only call cannot turn unlimited on as a side effect.
  if (!options.planOnly) {
    const value = !options.revoke;
    if (options.verifications) body.unlimitedVerifications = value;
    if (options.images) body.unlimitedImages = value;
  }

  const parts = [];
  if (planChange) parts.push(`plan ${options.tier ?? '(unchanged)'}${options.months !== null ? ` for ${options.months} month(s)` : ''}`);
  if (!options.planOnly) {
    parts.push(
      options.revoke
        ? `revoke unlimited ${[options.verifications ? 'verifications' : null, options.images ? 'image credits' : null].filter(Boolean).join(' + ')}`
        : `unlimited ${[options.verifications ? 'verifications' : null, options.images ? 'image credits' : null].filter(Boolean).join(' + ')}`,
    );
  }
  console.log(`Setting ${parts.join(' + ')} on ${options.ids.length} workspace(s)…`);

  let response;
  try {
    response = await fetchWithTimeout(`${API_URL}/admin/workspaces/plan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': ADMIN_SECRET,
      },
      body: JSON.stringify(body),
    }, 30_000);
  } catch (err) {
    console.error(`Request failed: ${err.message}`);
    return 3;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    console.error(`Unreadable response (HTTP ${response.status}).`);
    return 3;
  }

  if (!response.ok) {
    console.error(`HTTP ${response.status}: ${payload.error ?? 'request rejected'}`);
    return 1;
  }

  console.log(`\nGranted to ${payload.granted} workspace(s):`);
  for (const workspace of payload.workspaces ?? []) {
    const lines = [
      `  ${workspace.id}  ${workspace.name ?? ''}`,
      `    tier:          ${workspace.tier}${workspace.paidUntil ? ` until ${String(workspace.paidUntil).slice(0, 10)}` : ''}`,
      `    verifications: ${workspace.verificationCreditsUnlimited ? 'unlimited' : `${workspace.verificationCredits} left (${workspace.verificationCreditsMonthly}/mo)`}`,
      `    images:        ${workspace.imageCreditsUnlimited ? 'unlimited' : `${workspace.imageCredits} left (${workspace.imageCreditsMonthly}/mo)`}`,
    ];
    console.log(lines.join('\n'));
  }

  if (payload.missing?.length) {
    // Exit non-zero so a script that granted several accounts cannot report
    // success while quietly skipping one.
    console.error(`\nNot found: ${payload.missing.join(', ')}`);
    return 1;
  }

  return 0;
}

// Run only when invoked directly. Without this guard, importing main from
// upgrade-to-pro.mjs would execute a grant with this script's argv.
const invokedDirectly = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch(err => {
      console.error(err);
      process.exitCode = 3;
    });
}

export { main };
