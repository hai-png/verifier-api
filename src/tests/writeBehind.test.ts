import test from 'node:test';
import assert from 'node:assert/strict';
import { createWriteBehind } from '../utils/writeBehind';

test('write-behind batches pushes into a single flush', async () => {
    const batches: number[][] = [];
    const writer = createWriteBehind<number>({
        name: 'test-batch',
        intervalMs: 60_000,
        maxBatchSize: 100,
        flush: async (batch) => {
            batches.push(batch);
        },
    });

    writer.push(1);
    writer.push(2);
    writer.push(3);
    assert.equal(writer.size(), 3);

    await writer.flush();
    assert.deepEqual(batches, [[1, 2, 3]]);
    assert.equal(writer.size(), 0);
    assert.equal(writer.flushCount(), 1);
    writer.stop();
});

test('write-behind flushes as soon as maxBatchSize is reached', async () => {
    const batches: string[][] = [];
    const writer = createWriteBehind<string>({
        name: 'test-max-batch',
        intervalMs: 60_000,
        maxBatchSize: 2,
        flush: async (batch) => {
            batches.push(batch);
        },
    });

    writer.push('a');
    writer.push('b');
    await new Promise((resolve) => setImmediate(resolve));
    await writer.flush();

    assert.deepEqual(batches, [['a', 'b']]);
    writer.stop();
});

test('write-behind requeues a failed batch and retries on the next flush', async () => {
    let attempts = 0;
    const seen: number[][] = [];
    const writer = createWriteBehind<number>({
        name: 'test-retry',
        intervalMs: 60_000,
        maxBatchSize: 1_000,
        flush: async (batch) => {
            attempts += 1;
            if (attempts === 1) throw new Error('database unavailable');
            seen.push(batch);
        },
    });

    writer.push(7);
    await writer.flush();
    assert.equal(attempts, 1);
    assert.equal(writer.size(), 1, 'failed batch must be requeued');

    await writer.flush();
    assert.equal(attempts, 2);
    assert.deepEqual(seen, [[7]]);
    assert.equal(writer.size(), 0);
    assert.equal(writer.droppedCount(), 0);
    writer.stop();
});

test('write-behind drops the oldest entries when the buffer overflows', async () => {
    const writer = createWriteBehind<number>({
        name: 'test-overflow',
        intervalMs: 60_000,
        maxBatchSize: 1_000,
        maxBufferSize: 3,
        flush: async () => {
            throw new Error('still down');
        },
    });

    for (let i = 0; i < 3; i += 1) writer.push(i);
    await writer.flush();
    assert.equal(writer.size(), 3);

    for (let i = 3; i < 6; i += 1) writer.push(i);
    assert.ok(writer.size() >= 3);
    await writer.flush();

    assert.equal(writer.size(), 3);
    assert.ok(writer.droppedCount() >= 3, 'overflow must be counted');
    writer.stop();
});

test('write-behind timer flushes once the interval elapses', async () => {
    const batches: string[][] = [];
    const writer = createWriteBehind<string>({
        name: 'test-timer',
        intervalMs: 20,
        maxBatchSize: 1_000,
        flush: async (batch) => {
            batches.push(batch);
        },
    });

    writer.push('timer');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(batches, [['timer']]);

    writer.stop();
    writer.push('after-stop');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(batches.length, 1, 'stop() must clear the timer');
    assert.equal(writer.size(), 1, 'items pushed after stop() stay buffered for the final flush');

    await writer.flush();
    assert.deepEqual(batches.at(-1), ['after-stop'], 'explicit flush still persists after stop()');
});
