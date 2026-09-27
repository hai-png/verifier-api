// Shutdown used to lose buffered analytics rows: flush() returns the in-flight
// promise without writing whatever arrived during it, so the process could
// disconnect Prisma and exit with rows still queued. drain() closes that gap,
// and the fatal handlers route an unhandled rejection into the same drain
// instead of Node's default immediate exit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWriteBehind } from '../utils/writeBehind';

test('drain writes everything that arrives during an in-flight flush', async () => {
  const written: number[] = [];
  let release: (() => void) | undefined;
  const writer = createWriteBehind<number>({
    name: 'test-drain',
    intervalMs: 60_000,
    maxBatchSize: 1_000,
    flush: async (batch) => {
      // Hold the first flush open so later pushes land mid-flight, which is
      // exactly the case a single flush() call would drop.
      if (release === undefined) {
        await new Promise<void>((r) => { release = r; });
      }
      written.push(...batch);
    },
  });

  writer.push(1);
  const flushing = writer.drain();
  // Arrives while the first flush is still in progress.
  writer.push(2);
  writer.push(3);
  await new Promise((r) => setTimeout(r, 10));
  release?.();
  await flushing;

  assert.deepEqual(written.sort((a, b) => a - b), [1, 2, 3],
    'every buffered item must be written before shutdown returns');
  assert.equal(writer.size(), 0, 'the buffer must be empty after drain');
});

test('a single flush would have dropped the mid-flight items', async () => {
  // Demonstrates the bug the drain() call site fixes.
  const written: number[] = [];
  let release: (() => void) | undefined;
  const writer = createWriteBehind<number>({
    name: 'test-flush-gap',
    intervalMs: 60_000,
    maxBatchSize: 1_000,
    flush: async (batch) => {
      if (release === undefined) await new Promise<void>((r) => { release = r; });
      written.push(...batch);
    },
  });

  writer.push(1);
  const flushing = writer.flush();
  writer.push(2);
  await new Promise((r) => setTimeout(r, 10));
  release?.();
  await flushing;

  assert.deepEqual(written, [1], 'plain flush stops after the in-flight batch');
  assert.equal(writer.size(), 1, 'item 2 is left behind, which is why drain() exists');
});

test('drain gives up rather than looping forever on a persistently failing flush', async () => {
  let attempts = 0;
  const writer = createWriteBehind<number>({
    name: 'test-drain-fail',
    intervalMs: 60_000,
    maxBatchSize: 1_000,
    flush: async () => { attempts += 1; throw new Error('database unavailable'); },
  });
  for (let i = 0; i < 5; i++) writer.push(i);
  await writer.drain(3);
  assert.ok(attempts <= 3, `drain must respect its round budget, made ${attempts} attempts`);
});
