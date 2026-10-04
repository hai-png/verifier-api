// Product oversell protection.
//
// A product with three slots and two buyers confirming at the same instant.
// The sold-out check used to count PAID orders and then compare to maxBuyers: two
// concurrent confirmations both read the same count, both concluded there was
// room, and both created an order — a product capped at 1 sold 2. The count
// could not be made safe by reordering statements; it was a read followed by a
// write with nothing in between holding a lock.
//
// The fix moves the capacity test inside a single conditional UPDATE:
//
//   UPDATE Product SET soldCount = soldCount + 1
//    WHERE id = ? AND soldCount < maxBuyers
//
// The database picks one winner and the loser updates zero rows.
//
// This file previously asserted the fix by *regex-matching the source text* for
// `soldCount: { lt: maxBuyers }`. That is not a test of the behaviour: it passed
// while the claim and the order insert were two separate statements, it failed
// the moment the pair was correctly moved into one transaction, and it would
// have passed unchanged if the conditional update were replaced by a
// non-atomic read-modify-write that happened to contain those words.
//
// So it is driven through the real router over HTTP instead, with Prisma
// recorded rather than executed. What is asserted is the predicate that reaches
// the database and the fact that the claim and the insert share a transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { AddressInfo } from 'node:net';
import { prisma } from '../utils/prisma';
import paymentLinksRouter from '../routes/paymentLinks';

interface Recorded {
  productUpdateMany: any[];
  orderCreates: any[];
  transactionCalls: number;
  inTransaction: boolean[];
}

function stubPrisma(t: any, options: {
  maxBuyers: number | null;
  soldCount: number;
  claimSucceeds?: boolean;
  linkPayoutAccounts?: any[];
}): Recorded {
  const recorded: Recorded = {
    productUpdateMany: [],
    orderCreates: [],
    transactionCalls: 0,
    inTransaction: [],
  };
  const originals: Array<() => void> = [];
  const replace = (object: any, key: string, value: any) => {
    const original = object[key];
    object[key] = value;
    originals.push(() => { object[key] = original; });
  };

  replace(prisma, '$queryRaw', async () => []);
  replace(prisma.paymentLink, 'findUnique', async () => ({
    id: 'link-1',
    workspaceId: 'ws-1',
    productId: 'prod-1',
    name: 'Course',
    mode: 'PRODUCT',
    status: 'ACTIVE',
    expiresAt: null,
    fixedAmount: 500,
    acceptedProviders: ['telebirr'],
    redirectUrl: null,
    product: { id: 'prod-1', name: 'Course', maxBuyers: options.maxBuyers },
    payoutAccounts: options.linkPayoutAccounts ?? [{
      id: 'pa-1',
      label: 'Main',
      accountHolderName: 'Course Shop PLC',
      account: '0911000000',
      type: 'PHONE',
      providersAllowed: ['telebirr'],
    }],
  }));
  replace(prisma.paymentLink, 'updateMany', async () => ({ count: 0 }));
  replace(prisma.order, 'findUnique', async () => null);
  replace(prisma.order, 'findFirst', async () => null);
  // The advisory pre-check that keeps the common sold-out case from spending
  // seconds on the provider. It is a fast path, not the enforcement point, and
  // the enforcement point is what these tests assert on.
  replace(prisma.order, 'count', async () => options.soldCount);
  replace(prisma.order, 'create', async (args: any) => {
    recorded.orderCreates.push(args.data);
    recorded.inTransaction.push(recorded.transactionCalls > 0);
    return { id: 'order-1', ...args.data, createdAt: new Date() };
  });

  replace(prisma.product, 'updateMany', async (args: any) => {
    recorded.productUpdateMany.push(args);
    return { count: options.claimSucceeds === false ? 0 : 1 };
  });
  // Read back after a capped claim, to decide whether to fire product.sold_out.
  replace(prisma.product, 'findUniqueOrThrow', async () => ({
    soldCount: options.soldCount + (options.claimSucceeds === false ? 0 : 1),
  }));
  replace(prisma.webhook, 'findMany', async () => []);
  replace(prisma.notificationChannel, 'findMany', async () => []);

  // A real interactive transaction needs a real connection, so this stands in for
  // one while still letting the test observe whether the claim and the insert ran
  // inside the same unit of work.
  replace(prisma, '$transaction', async (fn: any) => {
    recorded.transactionCalls += 1;
    const tx = {
      product: { updateMany: prisma.product.updateMany },
      order: { create: prisma.order.create },
    };
    return typeof fn === 'function' ? fn(tx) : Promise.all(fn);
  });

  t.after(() => originals.reverse().forEach((restore) => restore()));
  return recorded;
}

function stubProvider(t: any, data: Record<string, unknown>): void {
  const verifyUniversal = require('../services/verifyUniversal');
  const original = verifyUniversal.runSmartVerify;
  verifyUniversal.runSmartVerify = async () => ({ success: true, httpStatus: 200, data });
  t.after(() => { verifyUniversal.runSmartVerify = original; });
}

const BUYER = { reference: 'CE2513001XYT', provider: 'telebirr', buyerName: 'Buyer', buyerEmail: 'b@example.com', buyerPhone: '0911777777' };

async function confirm(url: string, body: Record<string, unknown> = BUYER) {
  const response = await fetch(`${url}/link-1/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body: parsed };
}

async function mount(t: any) {
  const app = express();
  app.use(express.json());
  app.use('/payment-links', paymentLinksRouter);
  // Surface a thrown handler as the body, so a failing assertion names the cause
  // instead of reporting a JSON parse error on Express's HTML error page.
  app.use((err: Error, _req: any, res: any, _next: any) => {
    res.status(599).json({ unhandled: err.message });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/payment-links`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => setImmediate(r));
  });
  return url;
}

test('the capacity test reaches the database inside the WHERE clause of the increment', async (t) => {
  const recorded = stubPrisma(t, { maxBuyers: 1, soldCount: 0 });
  stubProvider(t, { settledAmount: '500 Birr', creditedPartyAccountNo: '0911000000', payerTelebirrNo: '0911777777' });
  const url = await mount(t);

  const result = await confirm(url);
  assert.equal(result.status, 201, JSON.stringify(result.body));

  assert.equal(recorded.productUpdateMany.length, 1, 'exactly one claim attempt');
  const claim = recorded.productUpdateMany[0];
  // The predicate that decides the winner lives in `where`, not in a read the
  // handler performed beforehand. This is the property that makes two concurrent
  // buyers safe, and it is the property the old regex test could not see.
  assert.deepEqual(
    claim.where,
    { id: 'prod-1', soldCount: { lt: 1 } },
    'capacity must be enforced by the conditional UPDATE itself',
  );
  assert.deepEqual(claim.data, { soldCount: { increment: 1 } });
});

test('the advisory count refuses an already-sold product before any provider work', async (t) => {
  // The cheap pre-check. It is not the enforcement point — it can be stale in
  // either direction — but when it is already at the cap there is no reason to
  // spend seconds talking to a bank.
  const recorded = stubPrisma(t, { maxBuyers: 1, soldCount: 1 });
  stubProvider(t, { settledAmount: '500 Birr', creditedPartyAccountNo: '0911000000', payerTelebirrNo: '0911777777' });
  const url = await mount(t);

  const result = await confirm(url);
  assert.equal(result.status, 409);
  assert.match(result.body.error, /sold out/i);
  assert.equal(recorded.productUpdateMany.length, 0, 'a product already at its cap needs no claim');
});

test('the atomic claim refuses the loser of a real race and creates no order', async (t) => {
  // The interesting case, and the one only the conditional UPDATE can handle:
  // the advisory count said there was room (0 sold, cap 1) and the database then
  // reported the single conditional UPDATE affected zero rows, because a
  // concurrent buyer took that slot in between. A read-then-write implementation
  // cannot produce this outcome and so cannot pass this test.
  const recorded = stubPrisma(t, { maxBuyers: 1, soldCount: 0, claimSucceeds: false });
  stubProvider(t, { settledAmount: '500 Birr', creditedPartyAccountNo: '0911000000', payerTelebirrNo: '0911777777' });
  const url = await mount(t);

  const result = await confirm(url);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'SOLD_OUT');
  assert.equal(recorded.orderCreates.length, 0, 'a refused claim must not create an order');
});

test('the claim and the order insert share one transaction', async (t) => {
  // Two separate statements with a compensating decrement meant a process kill
  // between them left soldCount permanently inflated — the product silently lost
  // stock it still had, and nothing anywhere decremented on a refund either.
  const recorded = stubPrisma(t, { maxBuyers: 5, soldCount: 2 });
  stubProvider(t, { settledAmount: '500 Birr', creditedPartyAccountNo: '0911000000', payerTelebirrNo: '0911777777' });
  const url = await mount(t);

  const result = await confirm(url);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(recorded.transactionCalls, 1, 'a capped product must claim and insert atomically');
  assert.deepEqual(recorded.inTransaction, [true], 'the order insert ran outside the transaction');
});

test('an uncapped product is never refused and does not claim a slot', async (t) => {
  const recorded = stubPrisma(t, { maxBuyers: null, soldCount: 999 });
  stubProvider(t, { settledAmount: '500 Birr', creditedPartyAccountNo: '0911000000', payerTelebirrNo: '0911777777' });
  const url = await mount(t);

  const result = await confirm(url);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(recorded.productUpdateMany.length, 0, 'no cap means no claim to make');
  assert.equal(recorded.orderCreates.length, 1);
});

test('a concurrent pair cannot both win: the loser is refused, never both sold', async (t) => {
  // Two buyers, one slot. The stub answers count 1 for the first caller and 0 for
  // the second — which is exactly what the single conditional UPDATE does under
  // concurrency. Asserting on the responses, not on a JS reimplementation, is what
  // makes this meaningful.
  let claims = 0;
  const recorded = stubPrismOnce(t, () => { claims += 1; return claims === 1 ? 1 : 0; });
  stubProvider(t, { settledAmount: '500 Birr', creditedPartyAccountNo: '0911000000', payerTelebirrNo: '0911777777' });
  const url = await mount(t);

  const [first, second] = await Promise.all([confirm(url), confirm(url)]);
  const statuses = [first.status, second.status].sort();

  assert.deepEqual(statuses, [201, 409], `one buyer wins and one is refused; got ${statuses.join(',')}`);
  assert.equal(recorded.orderCreates.length, 1, 'exactly one order for one slot');
});

function stubPrismOnce(t: any, nextCount: () => number) {
  const recorded = stubPrisma(t, { maxBuyers: 1, soldCount: 0 });
  const prismaModule = require('../utils/prisma').prisma;
  const original = prismaModule.product.updateMany;
  prismaModule.product.updateMany = async (args: any) => {
    recorded.productUpdateMany.push(args);
    return { count: nextCount() };
  };
  t.after(() => { prismaModule.product.updateMany = original; });
  return recorded;
}
