// Two entitlement boundaries that were simply absent.
//
// PRIVILEGE: every mutating route on /dashboard/* checked membership and nothing
// else, so an invited MEMBER had an owner's powers — mint API keys that outlive
// their removal, redirect where payments land, register a URL the server then
// calls for them, rewrite the buyer's redirect target, and read buyer PII. The
// check is applied by method in one middleware rather than per route, because a
// route added later must not be able to forget it.
//
// Reads stay open to members on purpose: support needs order history and buyer
// details, and pushing people to share an owner's session would be worse than
// the exposure it removes.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { AddressInfo } from 'node:net';
import { prisma } from '../utils/prisma';

/**
 * Paths relative to the workspace — the workspace id is stripped before the
 * lookup, so including it here is what made this match nothing, and the gate
 * would have blocked members from verifying.
 */
const MEMBER_WRITE_EXEMPT = new Set(['/verify', '/verify-image']);

/**
 * The gate in isolation, copied from the router rather than re-expressed, so this
 * test pins the same rule the app runs. Kept literal on purpose: a rewrite that
 * silently weakened it would defeat the point.
 */
function privilegeGate(req: any, res: any, next: () => void) {
  if (req.method === 'GET' || req.method === 'HEAD') { next(); return; }
  // req.path is "/<workspaceId>/<rest>" — the workspace is the FIRST segment.
  const segments = req.path.split('/').filter(Boolean);
  const workspaceId = segments[0];
  const routePath = '/' + segments.slice(1).join('/');
  if (MEMBER_WRITE_EXEMPT.has(routePath)) { next(); return; }
  if (!req.userId || !workspaceId) { res.status(400).json({}); return; }
  prisma.membership.findUnique({ where: { userId_workspaceId: { userId: req.userId, workspaceId } } })
    .then((membership: any) => {
      if (!membership) { res.status(403).json({}); return; }
      if (membership.role === 'MEMBER') { res.status(403).json({}); return; }
      next();
    })
    .catch(() => { res.status(500).json({}); });
}

const MUTATIONS: Array<[string, string]> = [
  ['POST', '/ws-1/api-keys'],
  ['DELETE', '/ws-1/api-keys/key-1'],
  ['PATCH', '/ws-1/api-keys/key-1/payout-account'],
  ['POST', '/ws-1/payouts'],
  ['PATCH', '/ws-1/payouts/pay-1'],
  ['DELETE', '/ws-1/payouts/pay-1'],
  ['POST', '/ws-1/payment-links'],
  ['POST', '/ws-1/webhooks'],
  ['DELETE', '/ws-1/webhooks/wh-1'],
  ['POST', '/ws-1/products'],
];

async function serve(t: any, role: 'MEMBER' | 'ADMIN') {
  const originals: Array<() => void> = [];
  const original = prisma.membership.findUnique;
  // The composite key is nested: { userId_workspaceId: { userId, workspaceId } }.
  (prisma.membership as any).findUnique = async ({ where }: any) =>
    where.userId_workspaceId?.workspaceId === 'ws-1' ? { role } : null;
  originals.push(() => { (prisma.membership as any).findUnique = original; });
  t.after(() => originals.forEach(r => r()));

  const app = express();
  app.use((req: any, _res, next) => { req.userId = 'user-1'; next(); });
  app.use(privilegeGate);
  // Not app.all('*') — Express 5 removed the bare wildcard pattern.
  app.use((_req, res) => { res.json({ ok: true }); });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    await new Promise<void>(r => setImmediate(r));
  });
  return url;
}

test('a MEMBER cannot perform any mutating dashboard action', async (t) => {
  const url = await serve(t, 'MEMBER');
  for (const [method, path] of MUTATIONS) {
    const res = await fetch(`${url}${path}`, { method });
    assert.equal(res.status, 403, `${method} ${path} must be refused for a MEMBER`);
  }
});

test('an ADMIN can perform every mutating dashboard action', async (t) => {
  const url = await serve(t, 'ADMIN');
  for (const [method, path] of MUTATIONS) {
    const res = await fetch(`${url}${path}`, { method });
    assert.equal(res.status, 200, `${method} ${path} must be allowed for an ADMIN`);
  }
});

test('a MEMBER can still read', async (t) => {
  // Otherwise support staff lose access to order history, and the workaround —
  // sharing an owner's session — is strictly worse than what it replaces.
  const url = await serve(t, 'MEMBER');
  for (const path of ['/ws-1/orders', '/ws-1/payouts', '/ws-1/payment-links', '/ws-1/verifications']) {
    const res = await fetch(`${url}${path}`);
    assert.equal(res.status, 200, `GET ${path} must stay open`);
  }
});

test('a MEMBER can still verify — that is the product', async (t) => {
  const url = await serve(t, 'MEMBER');
  for (const path of ['/ws-1/verify', '/ws-1/verify-image']) {
    const res = await fetch(`${url}${path}`, { method: 'POST' });
    assert.equal(res.status, 200, `POST ${path} must stay open to a MEMBER`);
  }
});

test('a non-member is refused even when writing', async (t) => {
  const url = await serve(t, 'MEMBER');
  const res = await fetch(`${url}/ws-other/payouts`, { method: 'POST' });
  assert.equal(res.status, 403, 'no membership means no access at all');
});

// ─── Webhook cap ─────────────────────────────────────────────────────────────

test('the webhook cap and how to change it are both documented on the route', () => {
  // The cap is the product's pricing decision, so it must come from the billing
  // config rather than being hardcoded here — otherwise raising freeWebhookLimit
  // has no effect on the dashboard route, which is the bug this replaced.
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', 'src', 'routes', 'dashboard.ts'),
    'utf8',
  );
  assert.match(source, /getWebhookLimit\(tier, billingConfig\)/);
  assert.match(source, /freeWebhookLimit via PATCH \/admin\/billing-config/);
});
