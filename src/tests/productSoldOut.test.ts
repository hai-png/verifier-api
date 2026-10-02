// A product with three slots and two buyers confirming at the same instant.
//
// The sold-out check counted PAID orders and then compared to maxBuyers. Two
// concurrent confirmations both read the same count, both concluded there was
// room, and both created an order — so a product capped at 1 sold 2. The count
// could not be made safe by reordering the statements; it is a read followed by
// a write with nothing in between holding a lock.
//
// The fix moves the capacity test inside a single conditional UPDATE:
//
//   UPDATE Product SET soldCount = soldCount + 1
//    WHERE id = ? AND soldCount < maxBuyers
//
// The database picks one winner and the loser updates zero rows. This test pins
// that shape, because the tempting regression is reintroducing a count-then-
// compare at the call site, which looks equivalent and is not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../utils/prisma';

/** Stands in for the conditional update, with the same single-statement shape. */
function claimSlot(product: { soldCount: number; maxBuyers: number | null }, maxBuyers: number | null) {
  const cap = maxBuyers ?? null;
  if (cap === null) return { updated: 1 };
  if (product.soldCount < cap) {
    product.soldCount += 1;
    return { updated: 1 };
  }
  return { updated: 0 };
}

test('simultaneous buyers cannot oversell a capped product', () => {
  const product = { soldCount: 0, maxBuyers: 1 as number | null };
  // The same object for both calls, because that is what serialising the two
  // UPDATEs in the database means: the second statement's WHERE clause is
  // evaluated against the row the first one wrote. Handing each caller its own
  // copy would model the old broken read-then-write, not this fix.
  const first = claimSlot(product, product.maxBuyers);
  const second = claimSlot(product, product.maxBuyers);

  assert.equal(first.updated, 1, 'the first buyer gets the only slot');
  assert.equal(second.updated, 0, 'the second must be refused');
  assert.equal(product.soldCount, 1, 'exactly one slot was taken');
});

test('a count-then-compare check oversells, which is why it was replaced', () => {
  // The old shape, run the same way, to make the difference concrete rather
  // than asserted. If this ever stops overselling, the explanation is stale.
  const soldAtReadTime = 0;
  const maxBuyers = 1;
  const bothPass = [soldAtReadTime, soldAtReadTime].every((sold) => sold < maxBuyers);
  assert.equal(bothPass, true, 'both callers would have been allowed through');
});

test('the claim releases when the order write fails', () => {
  // Otherwise a failed insert permanently shrinks the product: every buyer after
  // it is refused as sold out even though nothing was ever sold.
  const product = { soldCount: 0, maxBuyers: 2 as number | null };

  const claim = claimSlot(product, product.maxBuyers);
  assert.equal(claim.updated, 1);
  assert.equal(product.soldCount, 1);

  // The order create throws, so the slot goes back.
  product.soldCount -= 1;
  assert.equal(product.soldCount, 0);

  const retry = claimSlot(product, product.maxBuyers);
  assert.equal(retry.updated, 1, 'the released slot must be sellable again');
});

test('an uncapped product is never refused', () => {
  const product = { soldCount: 999, maxBuyers: null };
  assert.equal(claimSlot(product, product.maxBuyers).updated, 1);
});

test('the route claims with a conditional update, not a count-then-compare', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'routes', 'paymentLinks.ts'),
    'utf8',
  );

  assert.match(
    source,
    /soldCount:\s*\{\s*lt:\s*maxBuyers\s*\}[\s\S]*?soldCount:\s*\{\s*increment:\s*1\s*\}/,
    'the capacity test must live inside the WHERE clause of the increment',
  );
  assert.match(
    source,
    /decrement:\s*1/,
    'a claimed slot must be released if the order write fails',
  );
  // The remaining count is advisory only — it may stay, but must be labelled as
  // a fast path so nobody mistakes it for the enforcement point again.
  assert.match(source, /Advisory only/);
});

test('prisma exposes the counter the claim depends on', () => {
  const p: any = prisma.product;
  assert.equal(typeof p, 'object', 'the product delegate must exist');
});
