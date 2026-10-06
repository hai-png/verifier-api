// Verify the local .env backup holds every variable the service needs to boot.
//
// Run this BEFORE deleting a Render service. The Render API does not return
// secret-typed variables, so `tools/capture-env.cjs` recovers only the
// non-secret ones — six required values have to come from the dashboard by hand.
// This is the go/no-go check for that: it names exactly what is still missing.
//
// Reads key NAMES and value LENGTHS. Never prints a value.
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');

// Every variable the code reads that the service cannot boot without, or that
// silently disables a feature when absent. Grouped by what happens if it is
// missing, so the output says which are fatal and which are quiet.
const REQUIRED = [
  { key: 'DATABASE_URL', why: 'FATAL — nothing can reach the database' },
  { key: 'ADMIN_SECRET', why: 'FATAL — refuses to start in production' },
  { key: 'DASHBOARD_SECRET', why: 'FATAL — refuses to start in production' },
];

const FEATURE = [
  { key: 'MISTRAL_API_KEY', why: '/verify-image OCR disabled' },
  { key: 'FALLBACK_PROXIES', why: 'Telebirr verification unavailable from outside Ethiopia' },
  { key: 'TELEBIRR_PROXY_KEY', why: 'relay rejects the request' },
  { key: 'MPESA_FALLBACK_URL', why: 'M-Pesa verification unavailable' },
  { key: 'MPESA_PROXY_KEY', why: 'M-Pesa relay rejects the request' },
  { key: 'REDIS_URL', why: 'webhook + notification queues disabled' },
  { key: 'RESEND_API_KEY', why: 'notification emails fail' },
  { key: 'VERITAS_NOTIFICATIONS_FROM_EMAIL', why: 'notification emails fail' },
  { key: 'STATUS_MONITOR_SECRET', why: '/status/summary diagnostics withheld (safe)' },
  { key: 'VERITAS_APP_URL', why: 'upgrade links and password-reset links point nowhere' },
  { key: 'CORS_ALLOWED_ORIGINS', why: 'cross-origin browser calls blocked (safe if same-origin)' },
  { key: 'TRUST_FORWARDED_HEADERS', why: 'per-IP rate limits key on the proxy address (safe default)' },
];

function readEnv() {
  if (!fs.existsSync(ENV_PATH)) return null;
  const map = new Map();
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

const env = readEnv();
if (!env) {
  console.log('No .env found at ' + ENV_PATH);
  console.log('');
  console.log('If you have not captured anything yet:');
  console.log('  node tools/capture-env.cjs <service-id>');
  console.log('That recovers the non-secret variables only. The secret-typed ones —');
  console.log('DATABASE_URL, ADMIN_SECRET, DASHBOARD_SECRET, MISTRAL_API_KEY,');
  console.log('FALLBACK_PROXIES, TELEBIRR_PROXY_KEY — must be copied from the Render');
  console.log('dashboard into .env by hand.');
  process.exit(1);
}

let fatalMissing = 0;
let featureMissing = 0;

console.log('Backup: ' + ENV_PATH + '  (' + env.size + ' variables)');
console.log('');
console.log('Required to boot');
for (const { key, why } of REQUIRED) {
  const v = env.get(key);
  const ok = typeof v === 'string' && v.length > 0;
  if (!ok) fatalMissing++;
  console.log('  ' + (ok ? 'ok     ' : 'MISSING') + '  ' + key.padEnd(33) + why
    + (ok ? '  (' + v.length + ' chars)' : ''));
}

console.log('');
console.log('Feature variables');
for (const { key, why } of FEATURE) {
  const v = env.get(key);
  const ok = typeof v === 'string' && v.length > 0;
  if (!ok) featureMissing++;
  console.log('  ' + (ok ? 'ok     ' : 'absent ') + '  ' + key.padEnd(33) + why
    + (ok ? '  (' + v.length + ' chars)' : ''));
}

console.log('');
if (fatalMissing > 0) {
  console.log('RESULT: NOT SAFE TO DELETE. ' + fatalMissing + ' required variable(s) missing.');
  console.log('Copy them from Render -> <service> -> Environment into .env, then re-run.');
  process.exit(2);
}
console.log('RESULT: safe to delete and recreate.');
if (featureMissing > 0) {
  console.log('        ' + featureMissing + ' feature variable(s) absent — the listed features');
  console.log('        will be disabled until you add them.');
}
process.exit(0);