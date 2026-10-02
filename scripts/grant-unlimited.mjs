#!/usr/bin/env node
/**
 * Grant or revoke unlimited credits for one or more workspaces.
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
 *
 * Environment:
 *   ADMIN_SECRET   required. The same value the API is configured with.
 *   SMOKE_API_URL  optional. Defaults to the production API.
 *
 * Reads ADMIN_SECRET from the environment rather than argv, so it does not land
 * in shell history or in the process list.
 */

const API_URL = (process.env.SMOKE_API_URL || 'https://verify.noveld.com.et').replace(/\/$/, '');
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

function parseArgs(argv) {
  const options = { verifications: true, images: true, revoke: false };
  const ids = [];
  for (const arg of argv) {
    if (arg === '--verify-only') options.images = false;
    else if (arg === '--images-only') options.verifications = false;
    else if (arg === '--revoke') options.revoke = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else ids.push(arg);
  }
  return { ...options, ids };
}

function usage() {
  console.log(`Grant or revoke unlimited credits for a workspace.

Usage:
  node scripts/grant-unlimited.mjs <workspace-id> [more ids...]
  node scripts/grant-unlimited.mjs --verify-only <id>    unlimited verifications only
  node scripts/grant-unlimited.mjs --images-only <id>    unlimited image credits only
  node scripts/grant-unlimited.mjs --revoke <id>         revoke both
  node scripts/grant-unlimited.mjs --help

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
 * file src\win\async.c". So: clear the timer in finally, and set exitCode
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

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    usage();
    process.exitCode = 2;
    return;
  }

  if (options.help) { usage(); return; }
  if (!ADMIN_SECRET) {
    console.error('ADMIN_SECRET is not set. Nothing was sent.');
    console.error('PowerShell:  $env:ADMIN_SECRET = "..."');
    process.exitCode = 2;
    return;
  }
  if (options.ids.length === 0) {
    console.error('At least one workspace id is required.');
    usage();
    process.exitCode = 2;
    return;
  }
  if (options.revoke && !(options.verifications && options.images)) {
    console.error('--revoke cannot be combined with --verify-only or --images-only.');
    process.exitCode = 2;
    return;
  }

  const value = !options.revoke;
  const note = options.revoke
    ? 'revoked via grant-unlimited script'
    : 'granted via grant-unlimited script';

  const body = {
    workspaceIds: options.ids,
    note,
  };
  // Only send the flags this invocation actually touches, so a --verify-only
  // call cannot revoke an unrelated image grant by leaving it undefined.
  if (options.verifications) body.unlimitedVerifications = value;
  if (options.images) body.unlimitedImages = value;

  const verb = options.revoke ? 'Revoking' : 'Granting';
  const what = [
    options.verifications ? 'verifications' : null,
    options.images ? 'image credits' : null,
  ].filter(Boolean).join(' + ');

  console.log(`${verb} unlimited ${what} on ${options.ids.length} workspace(s)…`);

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
    process.exitCode = 3;
    return;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    console.error(`Unreadable response (HTTP ${response.status}).`);
    process.exitCode = 3;
    return;
  }

  if (!response.ok) {
    console.error(`HTTP ${response.status}: ${payload.error ?? 'request rejected'}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nGranted to ${payload.granted} workspace(s):`);
  for (const workspace of payload.workspaces ?? []) {
    console.log(
      `  ${workspace.id}  ${workspace.name ?? ''}\n` +
      `    verifications: ${workspace.verificationCreditsUnlimited ? 'unlimited' : `${workspace.verificationCredits} left`}\n` +
      `    images:        ${workspace.imageCreditsUnlimited ? 'unlimited' : `${workspace.imageCredits} left`}`,
    );
  }

  if (payload.missing?.length) {
    // Exit non-zero so a script that granted several accounts cannot report
    // success while quietly skipping one.
    console.error(`\nNot found: ${payload.missing.join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 3;
});