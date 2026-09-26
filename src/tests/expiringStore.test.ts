import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryWindowCounter } from '../utils/expiringStore';

test('counts hits within a window and resets after it expires', () => {
    const counter = new MemoryWindowCounter({ maxEntries: 100 });
    const t0 = 1_000_000;

    assert.equal(counter.increment('ip', 60_000, t0).count, 1);
    assert.equal(counter.increment('ip', 60_000, t0 + 10).count, 2);
    assert.equal(counter.increment('ip', 60_000, t0 + 20).count, 3);

    // New window after the previous one elapsed.
    const fresh = counter.increment('ip', 60_000, t0 + 60_001);
    assert.equal(fresh.count, 1);
    assert.equal(fresh.windowStart, t0 + 60_001);
});

test('tracks keys independently and exposes the window start for Retry-After', () => {
    const counter = new MemoryWindowCounter({ maxEntries: 100 });
    const t0 = 5_000;

    counter.increment('a', 60_000, t0);
    const b = counter.increment('b', 60_000, t0 + 1_000);

    assert.equal(counter.size(), 2);
    assert.equal(b.windowStart, t0 + 1_000);
    assert.equal(counter.peek('a', 60_000, t0 + 2_000)?.count, 1);
    assert.equal(counter.peek('a', 60_000, t0 + 60_000), undefined, 'expired windows are dropped on peek');
});

test('sweeps expired entries instead of growing without bound', () => {
    const counter = new MemoryWindowCounter({ maxEntries: 1_000, sweepEvery: 10 });
    const t0 = 0;

    for (let i = 0; i < 500; i += 1) {
        counter.increment(`ip-${i}`, 1_000, t0 + i);
    }
    assert.equal(counter.size(), 500, 'nothing expired yet');

    // Everything from t0 is now expired; the sweep runs every 10 increments.
    for (let i = 0; i < 20; i += 1) {
        counter.increment(`late-${i}`, 1_000, t0 + 10_000 + i);
    }

    assert.ok(counter.size() <= 30, `expired keys must be swept (size=${counter.size()})`);
    assert.ok(counter.sweepCount() >= 1);
});

test('evicts the oldest keys when the store is full', () => {
    const counter = new MemoryWindowCounter({ maxEntries: 50, sweepEvery: 5 });
    for (let i = 0; i < 500; i += 1) {
        counter.increment(`key-${i}`, 60_000, 1_000 + i);
    }
    assert.ok(counter.size() <= 50, `store must stay bounded (size=${counter.size()})`);
});
