// Two payment-link defects:
//  1. GET /:id/recent-order took no auth context and derived the tenant from the
//     client-supplied link id, so any authenticated workspace could read another
//     tenant's order (buyer name, email, phone, reference, amount).
//  2. POST /:id/confirm is unauthenticated by design (a buyer has no key) but
//     calls the provider directly with no limit, which is an unmetered way to
//     drive real bank traffic and to flood a merchant's webhooks.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { AddressInfo } from 'node:net';
import { prisma } from '../utils/prisma';
import paymentLinksRouter from '../routes/paymentLinks';

const VICTIM_LINK = 'link-victim';
const ATTACKER_LINK = 'link-attacker';
const VICTIM_WORKSPACE = 'ws-victim';
const ATTACKER_WORKSPACE = 'ws-attacker';

test('recent-order is scoped to the caller workspace', async (t) => {
  const originals: Array<() => void> = [];
  function replace(object: any, key: string, value: any) {
    const original = object[key];
    object[key] = value;
    originals.push(() => { object[key] = original; });
  }
  const linkLookups: any[] = [];
  const orderLookups: any[] = [];
  replace(prisma.paymentLink, 'findFirst', async (args: any) => {
    linkLookups.push(args.where);
    return args.where.id === VICTIM_LINK && args.where.workspaceId === VICTIM_WORKSPACE
      ? { id: VICTIM_LINK, workspaceId: VICTIM_WORKSPACE, productId: 'p1', redirectUrl: null, name: 'L', product: null }
      : null;
  });
  replace(prisma.paymentLink, 'findUnique', async (args: any) => {
    // The unscoped lookup that made the cross-tenant read possible.
    orderLookups.push(args);
    return { id: 'order-1', buyerName: 'Victim Buyer', buyerEmail: 'victim@example.com',
      buyerPhone: '+251900000000', reference: 'FT2513001V2G', amountPaid: 500 };
  });
  replace(prisma.order, 'findFirst', async () => null);
  t.after(() => originals.reverse().forEach((restore) => restore()));

  const app = express();
  app.use(express.json());
  // Stand in for apiKeyAuth: attach the caller's API key identity.
  app.use((req: any, _res, next) => {
    req.apiKeyData = { id: 'key-attacker', workspaceId: ATTACKER_WORKSPACE };
    next();
  });
  app.use('/payment-links', paymentLinksRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/payment-links`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => setImmediate(r));
  });

  // A foreign link id is not found for the caller's workspace: no order data.
  const foreign = await fetch(`${url}/${VICTIM_LINK}/recent-order?orderId=order-1`);
  assert.equal(foreign.status, 404);
  assert.ok(!(await foreign.text()).includes('victim@example.com'), 'cross-tenant buyer data leaked');
  assert.deepEqual(linkLookups.at(-1), { id: VICTIM_LINK, workspaceId: ATTACKER_WORKSPACE });
  // The unscoped findUnique must not be reached at all.
  assert.equal(orderLookups.length, 0, 'order was read without a tenant predicate');
});

test('payment confirmation is throttled per link and per client', async (t) => {
  const originals: Array<() => void> = [];
  function replace(object: any, key: string, value: any) {
    const original = object[key];
    object[key] = value;
    originals.push(() => { object[key] = original; });
  }
  // Stop before any provider work: an unknown link 404s, which is enough to show
  // the throttle runs first and the handler is never reached repeatedly.
  replace(prisma.paymentLink, 'findFirst', async () => null);
  replace(prisma.paymentLink, 'findUnique', async () => null);
  t.after(() => originals.reverse().forEach((restore) => restore()));

  const app = express();
  app.use(express.json());
  app.use('/payment-links', paymentLinksRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/payment-links`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => setImmediate(r));
  });

  const attempt = () => fetch(`${url}/link-throttle-test/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reference: 'CE2513001XYT', provider: 'telebirr', buyerName: 'a', buyerEmail: 'a@b.co' }),
  });

  const statuses: number[] = [];
  for (let i = 0; i < 24; i++) statuses.push((await attempt()).status);
  const throttled = statuses.filter((s) => s === 429);
  assert.ok(throttled.length > 0, `expected some requests to be throttled, got ${statuses.join(',')}`);
  // The first few still pass the throttle and reach the handler (404 link).
  assert.ok(statuses.filter((s) => s === 404).length > 0, 'throttle should not block the first attempts');
});
