/**
 * Scenario catalogue.
 *
 * Every scenario declares:
 *   name      — stable identifier used on the CLI and in reports
 *   group     — 'public' (no credentials) or 'authenticated' (needs an API key)
 *   describe  — what the request actually exercises
 *   external  — true when the request reaches a third-party provider
 *               (bank/telecom). External scenarios are opt-in for live runs so a
 *               load test never hammers Ethio Telecom / Safaricom / a bank.
 */
import crypto from 'node:crypto';

const jsonHeaders = { 'content-type': 'application/json' };

/**
 * Credentials for authenticated scenarios. Two modes are supported:
 *
 *   api-key          `x-api-key: sk_live_…` — what a real integration sends, but
 *                    minting one needs database access (see loadtest/seed.mjs),
 *                    which a run against a live deployment does not have.
 *   dashboard-secret `x-dashboard-key: <DASHBOARD_SECRET>` + `x-workspace-id`,
 *                    the same path the Next.js dashboard server uses. Read-only
 *                    with respect to setup: pick any existing workspace id.
 */
export function resolveAuth({ apiKey = null, dashboardKey = null, workspaceId = null } = {}) {
  if (apiKey) return { mode: 'api-key', headers: { 'x-api-key': apiKey } };
  if (dashboardKey) {
    if (!workspaceId) {
      throw new Error('Dashboard auth needs a workspace id too (--workspace-id / LOADTEST_WORKSPACE_ID)');
    }
    return {
      mode: 'dashboard-secret',
      workspaceId,
      headers: { 'x-dashboard-key': dashboardKey, 'x-workspace-id': workspaceId },
    };
  }
  return null;
}

/** Auth headers for a scenario, from either an auth object or a raw api key. */
export const authHeaders = ({ auth, apiKey } = {}) =>
  (auth ? { ...auth.headers } : { 'x-api-key': apiKey });

export const SCENARIOS = {
  health: {
    expectedStatuses: [200],
    group: 'public',
    external: false,
    describe: 'GET /health — liveness, no database, no upstream',
    request: () => ({ method: 'GET', path: '/health' }),
  },
  root: {
    expectedStatuses: [200],
    group: 'public',
    external: false,
    describe: 'GET / — static metadata payload',
    request: () => ({ method: 'GET', path: '/' }),
  },
  status_summary: {
    expectedStatuses: [200],
    group: 'public',
    external: false,
    describe: 'GET /status/summary — public capability summary',
    request: () => ({ method: 'GET', path: '/status/summary' }),
  },
  ready: {
    expectedStatuses: [200],
    group: 'public',
    external: false,
    describe: 'GET /ready — liveness + one database round trip (SELECT 1)',
    request: () => ({ method: 'GET', path: '/ready' }),
  },
  auth_missing_401: {
    expectedStatuses: [401],
    group: 'public',
    external: false,
    describe: 'POST /verify-cbe without a key — rejection path, no database',
    request: () => ({
      method: 'POST',
      path: '/verify-cbe',
      headers: jsonHeaders,
      body: { reference: 'FT2513001V2G', accountSuffix: '39003377' },
    }),
  },
  auth_invalid_403: {
    expectedStatuses: [403],
    group: 'public',
    external: false,
    describe: 'POST /verify-cbe with an unknown key — one hashed-key database lookup',
    request: () => ({
      method: 'POST',
      path: '/verify-cbe',
      headers: { ...jsonHeaders, 'x-api-key': `sk_live_${crypto.randomBytes(24).toString('hex')}` },
      body: { reference: 'FT2513001V2G', accountSuffix: '39003377' },
    }),
  },
  verify_validate_400: {
    expectedStatuses: [400],
    group: 'authenticated',
    external: false,
    describe: 'POST /verify-cbe with a malformed reference — auth + quota + validation',
    request: (ctx) => ({
      method: 'POST',
      path: '/verify-cbe',
      headers: { ...jsonHeaders, ...authHeaders(ctx) },
      body: { reference: 'NOT-A-REAL-REFERENCE', accountSuffix: '12345678' },
    }),
  },
  permissions_403: {
    expectedStatuses: [403],
    group: 'authenticated',
    external: false,
    describe: 'GET /products with a verify-only key — permission gate path',
    request: (ctx) => ({
      method: 'GET',
      path: '/products',
      headers: authHeaders(ctx),
    }),
  },
  verify_mpesa_external: {
    group: 'authenticated',
    external: true,
    describe: 'POST /verify-mpesa with a synthetic receipt — reaches Safaricom via the PHP proxy',
    request: (ctx) => ({
      method: 'POST',
      path: '/verify-mpesa',
      headers: { ...jsonHeaders, ...authHeaders(ctx) },
      body: { reference: 'SFE4ND9J8K' },
    }),
  },
  verify_telebirr_external: {
    group: 'authenticated',
    external: true,
    describe: 'POST /verify-telebirr with a synthetic reference — reaches Ethio Telecom via the PHP proxy',
    request: (ctx) => ({
      method: 'POST',
      path: '/verify-telebirr',
      headers: { ...jsonHeaders, ...authHeaders(ctx) },
      body: { reference: 'CE2513001XYT' },
    }),
  },
  verify_universal_external: {
    group: 'authenticated',
    external: true,
    describe: 'POST /verify with a synthetic reference — smart router + upstream',
    request: (ctx) => ({
      method: 'POST',
      path: '/verify',
      headers: { ...jsonHeaders, ...authHeaders(ctx) },
      body: { reference: 'CE2513001XYT' },
    }),
  },
};

export const PUBLIC_SCENARIOS = Object.entries(SCENARIOS)
  .filter(([, s]) => s.group === 'public')
  .map(([name]) => name);

export const SAFE_DEFAULT_SCENARIOS = ['health', 'root', 'status_summary', 'ready', 'auth_missing_401', 'auth_invalid_403'];

export function resolveScenarios(names, { allowExternal = false } = {}) {
  if (!names || names.length === 0) return SAFE_DEFAULT_SCENARIOS.slice();
  const resolved = names.flatMap((name) => (name === 'all' ? Object.keys(SCENARIOS) : name.split(',')));
  const unknown = resolved.filter((name) => !SCENARIOS[name]);
  if (unknown.length) {
    throw new Error(`Unknown scenario(s): ${unknown.join(', ')}. Known: ${Object.keys(SCENARIOS).join(', ')}`);
  }
  if (!allowExternal) {
    const external = resolved.filter((name) => SCENARIOS[name].external);
    if (external.length) {
      throw new Error(
        `Scenario(s) ${external.join(', ')} talk to third-party providers. Re-run with --allow-external to include them.`,
      );
    }
  }
  return resolved;
}
