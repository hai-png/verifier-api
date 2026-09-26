import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient, classify } from '../lib/http.mjs';

async function fixture(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function run(t, baseUrl, args = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'loadtest-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['loadtest/run.mjs', '--base-url', baseUrl,
    '--out-dir', dir, '--scenarios', 'health', '--iterations', '2', '--warmup', '3', ...args]);
  child.stdout.resume(); child.stderr.resume();
  const [code] = await once(child, 'exit');
  const file = (await fs.readdir(dir)).find((f) => f.endsWith('.json'));
  return { code, report: file ? JSON.parse(await fs.readFile(path.join(dir, file))) : null };
}
test('warmups are excluded from counts and budgets', async (t) => {
  let count = 0;
  const url = await fixture(t, (_, res) => { res.statusCode = ++count <= 3 ? 500 : 200; res.end('{}'); });
  const { code, report } = await run(t, url, ['--budget-error-rate', '0']);
  assert.equal(code, 0);
  assert.equal(count, 5);
  assert.equal(report.latency.stages[0].aggregate.count, 2);
  assert.equal(report.failures.length, 0);
});
test('all failures and unexpected statuses fail without a budget', async (t) => {
  for (const status of [503, 404]) {
    const url = await fixture(t, (_, res) => { res.statusCode = status; res.end(); });
    const { code, report } = await run(t, url);
    assert.equal(code, 1);
    assert.equal(report.latency.stages[0].aggregate.problemCount, 2);
  }
});
test('invalid configuration fails before issuing requests', async (t) => {
  const url = await fixture(t, () => assert.fail('must not send traffic'));
  for (const args of [['--profile', 'oops'], ['--stages', '0:1'], ['--iterations', '0']]) {
    assert.equal((await run(t, url, args)).code, 2);
  }
});
test('fresh unknown credentials on every request', async (t) => {
  const keys = new Set();
  const url = await fixture(t, (req, res) => { keys.add(req.headers['x-api-key']); res.statusCode = 403; res.end(); });
  const { code } = await run(t, url, ['--scenarios', 'auth_invalid_403']);
  assert.equal(code, 0);
  assert.equal(keys.size, 5);
});
test('deadline terminates a response that keeps streaming', async (t) => {
  const url = await fixture(t, (_, res) => {
    const timer = setInterval(() => res.write('x'), 10);
    res.on('close', () => clearInterval(timer));
  });
  const client = createClient({ baseUrl: url, timeoutMs: 100 });
  t.after(() => client.close());
  const result = await client.request();
  assert.equal(classify(result), 'client_timeout');
  assert.ok(result.totalMs < 1000);
});
test('load stages have distinct timeline offsets', async (t) => {
  const url = await fixture(t, (_, res) => setTimeout(() => res.end('{}'), 50));
  const { code, report } = await run(t, url, ['--profile', 'load', '--stages', '1:1.1,1:1.1']);
  assert.equal(code, 0);
  assert.ok(report.load.timeline.some((tick) => tick.second >= 2));
  assert.equal(report.load.timeline.reduce((n, tick) => n + tick.count, 0),
    report.load.stages.reduce((n, stage) => n + stage.aggregate.count, 0));
});
