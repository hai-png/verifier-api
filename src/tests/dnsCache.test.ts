import test from 'node:test';
import assert from 'node:assert/strict';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { createCachedDnsLookup } from '../utils/dnsCache';

type LookupResult = { error?: Error; address?: string; family?: number; all?: LookupAddress[] };

/** Call the callback-style lookup as a promise. */
function callLookup(
    lookup: LookupFunction,
    hostname: string,
    options: Record<string, unknown> = {}
): Promise<LookupResult> {
    return new Promise((resolve) => {
        const done = (value: LookupResult) => resolve(value);
        lookup(hostname, options as never, (...args: unknown[]) => {
            const error = args[0] as Error | null;
            if (error) {
                done({ error });
                return;
            }
            if (Array.isArray(args[1])) {
                done({ all: args[1] as LookupAddress[] });
                return;
            }
            done({ address: args[1] as string, family: args[2] as number });
        });
    });
}

test('caches a successful lookup and reuses it without re-resolving', async () => {
    let resolves = 0;
    const { lookup, stats } = createCachedDnsLookup(async () => {
        resolves += 1;
        return { address: `10.0.0.${resolves}`, family: 4 };
    });

    const first = await callLookup(lookup, 'relay.example');
    const second = await callLookup(lookup, 'relay.example');

    assert.equal(resolves, 1, 'the resolver must run exactly once');
    assert.equal(first.address, '10.0.0.1');
    assert.equal(second.address, '10.0.0.1', 'cached answer must be stable');
    assert.equal(stats().hits, 1);
    assert.equal(stats().misses, 1);
    assert.equal(stats().entries, 1);
});

test('a negative entry is served briefly and then retried', async () => {
    let attempts = 0;
    const { lookup } = createCachedDnsLookup(
        () => {
            attempts += 1;
            return attempts === 1
                ? Promise.reject(Object.assign(new Error('resolver failed'), { code: 'EAI_AGAIN' }))
                : Promise.resolve({ address: '10.0.0.9', family: 4 });
        },
        { ttlMs: 60_000, failureTtlMs: 20 }
    );

    const failed = await callLookup(lookup, 'relay.example');
    assert.ok(failed.error, 'first lookup must surface the resolver failure');

    await new Promise((resolve) => setTimeout(resolve, 5));
    const stillFailed = await callLookup(lookup, 'relay.example');
    assert.ok(stillFailed.error, 'failure must be negative-cached while fresh');

    await new Promise((resolve) => setTimeout(resolve, 20));
    const recovered = await callLookup(lookup, 'relay.example');
    assert.equal(recovered.address, '10.0.0.9', 'lookup must retry after the negative TTL');
    assert.equal(attempts, 2);
});

test('concurrent lookups for one host coalesce into a single resolve', async () => {
    let resolves = 0;
    const { lookup } = createCachedDnsLookup(async () => {
        resolves += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { address: '10.0.0.2', family: 4 };
    });

    const [a, b, c] = await Promise.all([
        callLookup(lookup, 'relay.example'),
        callLookup(lookup, 'relay.example'),
        callLookup(lookup, 'relay.example')
    ]);

    assert.equal(resolves, 1, 'in-flight requests must share one resolution');
    assert.equal(a.address, '10.0.0.2');
    assert.equal(b.address, '10.0.0.2');
    assert.equal(c.address, '10.0.0.2');
});

test('positive entries expire after the TTL', async () => {
    let resolves = 0;
    const { lookup } = createCachedDnsLookup(
        async () => ({ address: `10.0.1.${++resolves}`, family: 4 }),
        { ttlMs: 25 }
    );

    const before = await callLookup(lookup, 'relay.example');
    await new Promise((resolve) => setTimeout(resolve, 35));
    const after = await callLookup(lookup, 'relay.example');

    assert.equal(before.address, '10.0.1.1');
    assert.equal(after.address, '10.0.1.2', 'expired entries must re-resolve');
});

test('supports the all:true form used by some callers', async () => {
    const { lookup } = createCachedDnsLookup(async () => ({ address: '10.0.2.1', family: 4 }));

    const result = await callLookup(lookup, 'relay.example', { all: true });

    assert.ok(Array.isArray(result.all));
    assert.equal(result.all?.[0]?.address, '10.0.2.1');
});

test('evicts the oldest entry when the cache is full', async () => {
    let resolves = 0;
    const { lookup, stats } = createCachedDnsLookup(
        async (hostname) => ({ address: `10.0.3.${++resolves}`, family: 4 }),
        { maxEntries: 2 }
    );

    await callLookup(lookup, 'one.example');
    await callLookup(lookup, 'two.example');
    await callLookup(lookup, 'three.example');

    assert.equal(stats().entries, 2, 'cache must stay at the cap');
    assert.ok(stats().evictions >= 1, 'inserting a third host must evict one');

    // The oldest ('one.example') was evicted; it must resolve again.
    const firstResolvesBefore = resolves;
    await callLookup(lookup, 'one.example');
    assert.equal(resolves, firstResolvesBefore + 1, 'evicted host must re-resolve');
});
