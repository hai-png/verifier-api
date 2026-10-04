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

// The regression: one store served both the 60 s API-key windows and the 1 h
// anonymous `public:` window, and the sweep expired entries using the
// *triggering* key's windowMs. A `public:` bucket that had burned its 6/hour
// cap was therefore deleted by any API-key request 60 s later — the only
// throttle on unauthenticated verification silently became 6/minute.
test('a sweep driven by a short window cannot expire a long one', () => {
    const counter = new MemoryWindowCounter({ maxEntries: 1_000, sweepEvery: 4 });
    const t0 = 0;
    const HOUR = 3_600_000;
    const MINUTE = 60_000;

    for (let i = 0; i < 6; i += 1) {
        counter.increment('public:1.2.3.4', HOUR, t0);
    }
    assert.equal(counter.peek('public:1.2.3.4', HOUR, t0)?.count, 6);

    // Four fresh 60 s windows, 61 s in. Three of those increments trip sweeps.
    for (let i = 0; i < 4; i += 1) {
        counter.increment(`key-${i}`, MINUTE, t0 + 61_000 + i);
    }

    const surviving = counter.peek('public:1.2.3.4', HOUR, t0 + 62_000);
    assert.ok(surviving, 'the hour-long window must survive a 60 s sweep');
    assert.equal(surviving.count, 6, 'and must keep its count, not be reset to zero');
    assert.ok(counter.sweepCount() >= 1, 'a sweep really did run');
});

test('an evicted key resumes its count instead of restarting at one', () => {
    // maxEntries 4 and sweepEvery 2: a sweep runs on every second *new* key, and
    // evicts one key per sweep while over capacity. Evicting three entries here
    // puts `victim` in the tombstone map while leaving room for two more, so the
    // revive path is what the final assertion actually exercises.
    const counter = new MemoryWindowCounter({ maxEntries: 4, sweepEvery: 2, maxTombstones: 8 });
    const t0 = 0;
    const HOUR = 3_600_000;

    for (let i = 0; i < 4; i += 1) {
        counter.increment('victim', HOUR, t0);
    }
    assert.equal(counter.peek('victim', HOUR, t0)?.count, 4);

    for (let i = 0; i < 8; i += 1) {
        counter.increment(`flood-${i}`, HOUR, t0 + 1_000 + i);
    }
    assert.ok(counter.sweepCount() >= 3, `sweeps must have run (${counter.sweepCount()})`);
    assert.ok(counter.footprint() <= 4 + 8 + 2, `bounded (${counter.footprint()})`);

    const resumed = counter.increment('victim', HOUR, t0 + 2_000);
    assert.ok(resumed.count >= 4, `evicted key must resume, got ${resumed.count}`);
});

test('the footprint stays bounded even while tombstones are retained', () => {
    // Tombstones are best-effort: when more keys are evicted than can be
    // remembered, the oldest remembered one is dropped and its key restarts.
    // The important property is that the total footprint cannot grow with
    // attacker-supplied key cardinality.
    const counter = new MemoryWindowCounter({ maxEntries: 50, sweepEvery: 5, maxTombstones: 12 });
    for (let i = 0; i < 20_000; i += 1) {
        counter.increment(`key-${i}`, 60_000, 1_000 + i);
    }
    assert.ok(counter.footprint() <= 62, `footprint must be bounded (${counter.footprint()})`);
});

test('tombstones expire with their own window', () => {
    const counter = new MemoryWindowCounter({ maxEntries: 2, sweepEvery: 1, maxTombstones: 4 });
    const t0 = 0;
    counter.increment('gone', 1_000, t0);
    counter.increment('f1', 60_000, t0 + 1);
    counter.increment('f2', 60_000, t0 + 2);
    counter.increment('f3', 60_000, t0 + 3);
    assert.ok(counter.size() <= 6);

    // Well past the tombstone's own 1 s window: it must not come back.
    assert.equal(counter.peek('gone', 1_000, t0 + 10_000), undefined);
    assert.equal(counter.increment('gone', 1_000, t0 + 10_001).count, 1);
});
