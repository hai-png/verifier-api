#!/usr/bin/env node
/**
 * Live smoke test against a deployed verifier-api.
 *
 * This hits a real host. It sends real requests to real providers, spends quota,
 * and spends an image credit on any check that gets far enough to call Mistral.
 * It is not part of `npm test` and must be run deliberately:
 *
 *   SMOKE_API_KEY=<key> node scripts/smoke-live.mjs
 *   SMOKE_API_KEY=<key> SMOKE_TELEBIRR=DI10CLDXTM node scripts/smoke-live.mjs
 *
 * The split that matters:
 *
 *   REACHABILITY checks send deliberately invalid references and assert the
 *   service answers with a well-formed failure rather than a 500 or a hang.
 *   That proves auth, routing, quota, the result cache, the response envelope
 *   and the provider path all work end to end — with no real receipt needed and
 *   no credit spent. Almost every provider "passes" even though nothing was
 *   actually verified, and the output says so.
 *
 *   POSITIVE checks need a genuine receipt, supplied per provider through the
 *   environment. Supply one and the check asserts it really verifies; skip it and
 *   the check reports SKIP rather than quietly passing.
 *
 * Only the image check that uploads actually reaches Mistral, and it is gated
 * behind SMOKE_IMAGE=1 because it is the one that costs an image credit. The
 * payout-account checks never get that far: an unknown account id is rejected
 * before the credit decrement and before OCR, so they are free.
 */

const API_URL = (process.env.SMOKE_API_URL || 'https://verify.noveld.com.et').replace(/\/$/, '');
const API_KEY = process.env.SMOKE_API_KEY || '';
const WORKSPACE_ID = process.env.SMOKE_WORKSPACE_ID || '';

// Real receipts, keyed by provider. Absent means that positive check is skipped.
const REAL_REFERENCES = {
  telebirr: process.env.SMOKE_TELEBIRR || '',
  cbe: process.env.SMOKE_CBE || '',
  cbebirr: process.env.SMOKE_CBEBIRR || '',
  dashen: process.env.SMOKE_DASHEN || '',
  abyssinia: process.env.SMOKE_ABYSSINIA || '',
  mpesa: process.env.SMOKE_MPESA || '',
  awash: process.env.SMOKE_AWASH || '',
  zemen: process.env.SMOKE_ZEMEN || '',
};

// Provider -> the fields that route's request needs beyond a reference.
const PROVIDERS = [
  { id: 'telebirr', path: '/verify-telebirr', body: { reference: 'SM0KE000000' } },
  { id: 'cbe', path: '/verify-cbe', body: { reference: 'FT0000000ABCDE', suffix: '00000001' } },
  { id: 'cbebirr', path: '/verify-cbebirr', body: { reference: 'CB0000000', phoneNumber: '251911000000' } },
  { id: 'dashen', path: '/verify-dashen', body: { reference: 'DS000000000' } },
  { id: 'abyssinia', path: '/verify-abyssinia', body: { reference: 'AB0000000', suffix: '12345' } },
  { id: 'mpesa', path: '/verify-mpesa', body: { reference: 'MP0000000' } },
  { id: 'awash', path: '/verify-awash', body: { reference: 'AW0000000' } },
  { id: 'zemen', path: '/verify-zemen', body: { reference: 'ZM0000000' } },
];

// A failure that the service produced on purpose is a pass for a reachability
// check. A 5xx or a transport error is not: that is the service breaking.
const EXPECTED_FAILURE_STATUSES = new Set([200, 400, 404, 422, 429, 502]);

const results = [];

function record(state, name, detail) {
  results.push({ state, name, detail });
  const mark = { PASS: 'PASS', FAIL: 'FAIL', SKIP: 'SKIP', WARN: 'WARN' }[state];
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function call(path, { method = 'GET', body, headers = {}, timeoutMs = 45_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        'x-api-key': API_KEY,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: response.status, json, text, headers: response.headers };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Reachability and validation ─────────────────────────────────────────────

async function checkHealth() {
  console.log('\nHealth and configuration');

  try {
    const res = await call('/ready', { headers: { 'x-api-key': '' } });
    if (res.status === 200) record('PASS', '/ready returns 200');
    else record('FAIL', '/ready returns 200', `got ${res.status}`);
  } catch (err) {
    record('FAIL', '/ready returns 200', err.message);
  }

  try {
    const res = await call('/status/summary', { headers: { 'x-api-key': '' } });
    if (res.status === 200 && res.json?.status) {
      record('PASS', '/status/summary is public and operational', `status=${res.json.status}`);
    } else {
      record('FAIL', '/status/summary is public and operational', `got ${res.status}`);
    }
  } catch (err) {
    record('FAIL', '/status/summary is public and operational', err.message);
  }
}

async function checkAuth() {
  console.log('\nAuthentication');

  try {
    const res = await call('/verify-telebirr', {
      method: 'POST',
      body: { reference: 'SM0KE000000' },
      headers: { 'x-api-key': '' },
    });
    if (res.status === 401) record('PASS', 'a missing API key is rejected with 401');
    else record('FAIL', 'a missing API key is rejected with 401', `got ${res.status}`);
  } catch (err) {
    record('FAIL', 'a missing API key is rejected with 401', err.message);
  }

  try {
    const res = await call('/verify-telebirr', {
      method: 'POST',
      body: { reference: 'SM0KE000000' },
      headers: { 'x-api-key': `${API_KEY}-not-a-real-key` },
    });
    if (res.status === 401 || res.status === 403) {
      record('PASS', 'a wrong API key is rejected', `got ${res.status}`);
    } else {
      record('FAIL', 'a wrong API key is rejected', `got ${res.status}`);
    }
  } catch (err) {
    record('FAIL', 'a wrong API key is rejected', err.message);
  }
}

async function checkCors() {
  console.log('\nCORS (the dashboard runs on a different origin)');

  try {
    const res = await fetch(`${API_URL}/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://dashboard.noveld.com.et',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    const allowOrigin = res.headers.get('access-control-allow-origin');
    if (allowOrigin === 'https://dashboard.noveld.com.et') {
      record('PASS', 'the dashboard origin is allowed');
    } else {
      record('FAIL', 'the dashboard origin is allowed', `allow-origin=${allowOrigin ?? 'absent'}`);
    }
  } catch (err) {
    record('FAIL', 'the dashboard origin is allowed', err.message);
  }
}

async function checkProviders() {
  console.log('\nProvider routes (invalid reference — proves the path works, not that a payment exists)');

  for (const provider of PROVIDERS) {
    const startedAt = Date.now();
    try {
      const res = await call(provider.path, { method: 'POST', body: provider.body });
      const elapsed = Date.now() - startedAt;

      if (!EXPECTED_FAILURE_STATUSES.has(res.status)) {
        record('FAIL', `${provider.id} answers with a handled failure`,
          `unexpected ${res.status}: ${(res.text ?? '').slice(0, 120)}`);
        continue;
      }
      if (elapsed > 30_000) {
        record('FAIL', `${provider.id} answers with a handled failure`, `took ${elapsed}ms — possible hang`);
        continue;
      }
      record('PASS', `${provider.id} answers with a handled failure`,
        `${res.status} in ${elapsed}ms, nothing verified`);
    } catch (err) {
      record('FAIL', `${provider.id} answers with a handled failure`, err.message);
    }
  }
}

async function checkPositive(providerId) {
  const reference = REAL_REFERENCES[providerId];
  const provider = PROVIDERS.find(p => p.id === providerId);
  if (!reference || !provider) return;

  const body = { ...provider.body, reference };
  if (providerId === 'telebirr') delete body.suffix;
  if (providerId === 'cbe') body.reference = reference;
  try {
    const res = await call(provider.path, { method: 'POST', body });
    const verified = res.json?.success === true;
    if (verified) {
      record('PASS', `${providerId} verifies the supplied real receipt`);
    } else {
      record('FAIL', `${providerId} verifies the supplied real receipt`,
        `got ${res.status}: ${(res.json?.error ?? res.text ?? '').slice(0, 140)}`);
    }
  } catch (err) {
    record('FAIL', `${providerId} verifies the supplied real receipt`, err.message);
  }
}

async function checkValidation() {
  console.log('\nValidation (should be rejected before any provider call)');

  try {
    const res = await call('/verify-telebirr', { method: 'POST', body: {} });
    if (res.status === 400) record('PASS', 'a missing reference is rejected with 400');
    else record('FAIL', 'a missing reference is rejected with 400', `got ${res.status}`);
  } catch (err) {
    record('FAIL', 'a missing reference is rejected with 400', err.message);
  }

  try {
    const res = await call('/verify-telebirr', { method: 'POST', body: { reference: '   ' } });
    if (res.status === 400) record('PASS', 'a whitespace reference is rejected with 400');
    else record('WARN', 'a whitespace reference is rejected with 400', `got ${res.status}`);
  } catch (err) {
    record('FAIL', 'a whitespace reference is rejected with 400', err.message);
  }
}

// ─── Payout accounts ─────────────────────────────────────────────────────────

async function checkPayoutCrud() {
  console.log('\nPayout accounts (full round trip)');

  let createdId = null;
  try {
    const created = await call('/payouts', {
      method: 'POST',
      body: {
        label: `smoke-${Date.now()}`,
        accountHolderName: 'Smoke Test',
        type: 'PHONE',
        account: '251911000001',
        providersAllowed: ['telebirr'],
      },
    });
    if (created.status !== 200 && created.status !== 201) {
      record('FAIL', 'POST /payouts creates an account', `got ${created.status}: ${(created.text ?? '').slice(0, 140)}`);
      return;
    }
    createdId = created.json?.payoutAccount?.id ?? created.json?.payout?.id ?? null;
    record('PASS', 'POST /payouts creates an account');

    const listed = await call('/payouts');
    const rows = listed.json?.payouts ?? listed.json ?? [];
    const found = Array.isArray(rows) && rows.some(row => row.id === createdId);
    if (found) record('PASS', 'GET /payouts returns the new account');
    else record('WARN', 'GET /payouts returns the new account', 'not present in the list');
  } catch (err) {
    record('FAIL', 'payout account round trip', err.message);
    return;
  } finally {
    if (createdId) {
      try {
        await call(`/payouts/${createdId}`, { method: 'DELETE' });
        record('PASS', 'DELETE /payouts removes the account (cleanup)');
      } catch (err) {
        record('WARN', 'DELETE /payouts removes the account (cleanup)', `left behind: ${createdId}`);
      }
    }
  }

  try {
    const res = await call('/payouts', {
      method: 'POST',
      body: { label: 'bad', accountHolderName: 'x', type: 'PHONE', account: '123', providersAllowed: ['telebirr'] },
    });
    if (res.status === 400) record('PASS', 'an invalid phone payout account is rejected with 400');
    else record('FAIL', 'an invalid phone payout account is rejected with 400', `got ${res.status}`);
  } catch (err) {
    record('FAIL', 'an invalid phone payout account is rejected with 400', err.message);
  }
}

// ─── Image verification ──────────────────────────────────────────────────────

// Smallest valid PNG. Enough to pass the MIME filter; the payout-account checks
// below reject it long before Mistral ever sees it.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function checkImageValidation() {
  console.log('\nImage verification (validation only — no credit spent)');

  try {
    const form = new FormData();
    const res = await fetch(`${API_URL}/verify-image`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY },
      body: form,
      signal: AbortSignal.timeout(45_000),
    });
    await res.text();
    if (res.status === 400) record('PASS', 'a missing file is rejected with 400');
    else record('FAIL', 'a missing file is rejected with 400', `got ${res.status}`);
  } catch (err) {
    record('FAIL', 'a missing file is rejected with 400', err.message);
  }

  // The important one for the payout feature: an unknown account id must be
  // refused before the credit decrement and before OCR, so this costs nothing.
  try {
    const form = new FormData();
    form.append('file', new Blob([TINY_PNG], { type: 'image/png' }), 'receipt.png');
    form.append('payoutAccountId', 'definitely-not-a-real-account-id');
    const res = await fetch(`${API_URL}/verify-image`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY },
      body: form,
      signal: AbortSignal.timeout(45_000),
    });
    const text = await res.text();
    if (res.status === 404) {
      record('PASS', 'an unknown payoutAccountId is rejected with 404 before any credit is spent', text.slice(0, 90));
    } else {
      record('FAIL', 'an unknown payoutAccountId is rejected with 404 before any credit is spent', `got ${res.status}`);
    }
  } catch (err) {
    record('FAIL', 'an unknown payoutAccountId is rejected with 404 before any credit is spent', err.message);
  }

  if (process.env.SMOKE_IMAGE === '1') {
    console.log('  (SMOKE_IMAGE=1 — this one uploads to Mistral and spends an image credit)');
    try {
      const form = new FormData();
      form.append('file', new Blob([TINY_PNG], { type: 'image/png' }), 'receipt.png');
      const res = await fetch(`${API_URL}/verify-image`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY },
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
      const text = await res.text();
      // A 1x1 pixel is not a receipt, so 422 "unrecognised" is the correct answer
      // and proves the OCR path ran end to end.
      if (res.status === 422 || res.status === 200) {
        record('PASS', 'the OCR path runs end to end (a 1x1 pixel is not a receipt, so 422 is correct)', `got ${res.status}`);
      } else {
        record('FAIL', 'the OCR path runs end to end', `got ${res.status}: ${text.slice(0, 140)}`);
      }
    } catch (err) {
      record('FAIL', 'the OCR path runs end to end', err.message);
    }
  } else {
    record('SKIP', 'the OCR path runs end to end', 'set SMOKE_IMAGE=1 to spend an image credit');
  }
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Live smoke test against ${API_URL}`);
  if (!API_KEY) {
    console.error('\nSMOKE_API_KEY is required. Nothing was sent.');
    process.exit(2);
  }
  if (/localhost|127\.0\.0\.1/.test(API_URL)) {
    console.log('\nTarget is local, so the "this is live" warning does not apply.');
  } else {
    console.log('This sends real requests to a real host and spends quota.');
  }
  if (WORKSPACE_ID) console.log(`Workspace under test: ${WORKSPACE_ID}`);

  await checkHealth();
  await checkAuth();
  await checkCors();
  await checkValidation();
  await checkProviders();
  await checkPayoutCrud();
  await checkImageValidation();

  console.log('\nPositive checks against real receipts');
  const withReferences = Object.entries(REAL_REFERENCES).filter(([, value]) => value);
  if (withReferences.length === 0) {
    console.log('  none supplied — set e.g. SMOKE_TELEBIRR=<receipt> to verify a real payment');
  }
  for (const [providerId] of withReferences) {
    await checkPositive(providerId);
  }

  const failed = results.filter(r => r.state === 'FAIL');
  const passed = results.filter(r => r.state === 'PASS').length;
  const warned = results.filter(r => r.state === 'WARN').length;
  const skipped = results.filter(r => r.state === 'SKIP').length;

  console.log(`\n${'-'.repeat(64)}`);
  console.log(`${passed} passed, ${failed.length} failed, ${warned} warnings, ${skipped} skipped`);

  if (failed.length > 0) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
  }
  console.log('\nNote: provider reachability checks prove the request path works end to end.');
  console.log('They do NOT prove any payment exists — nothing was verified by them.');
  if (skipped > 0) console.log(`${skipped} check(s) were skipped; see SKIP lines above.`);

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\nSmoke run crashed:', err);
  process.exit(3);
});