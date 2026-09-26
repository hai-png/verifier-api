import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { verifyResultCache, verifyCacheStats, clearVerifyCache } from '../middleware/verifyResultCache';

interface Harness {
  url: string;
  close: () => Promise<void>;
  calls: () => number;
}

/** Boot a tiny app that mounts the middleware in front of a slow handler. */
async function startHarness(options: {
  delayMs?: number;
  handler?: (req: express.Request, res: express.Response) => void;
  workspaceId?: string;
} = {}): Promise<Harness> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Stand in for apiKeyAuth: every request belongs to one workspace.
    (req as any).apiKeyData = { workspace: { id: options.workspaceId ?? 'ws_test' } };
    next();
  });
  // Mounted exactly like production (per-endpoint prefix), so the middleware
  // sees a relative req.path.
  app.use('/verify-telebirr', verifyResultCache);
  let calls = 0;
  app.post('/verify-telebirr', async (req, res) => {
    calls += 1;
    if (options.handler) {
      options.handler(req, res);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 50));
    res.json({ success: true, receiptNo: req.body.reference });
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls: () => calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('concurrent identical verifications share one upstream call', async () => {
  clearVerifyCache();
  const harness = await startHarness({ delayMs: 120 });
  try {
    const [a, b, c] = await Promise.all([
      post(`${harness.url}/verify-telebirr`, { reference: 'CE2513001XYT' }),
      post(`${harness.url}/verify-telebirr`, { reference: 'CE2513001XYT' }),
      post(`${harness.url}/verify-telebirr`, { reference: 'CE2513001XYT' }),
    ]);

    assert.equal(harness.calls(), 1, 'only one upstream verification should run');
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(c.status, 200);
    const bodyA = await a.json();
    const bodyB = await b.json();
    assert.deepEqual(bodyA, bodyB);
    assert.equal(verifyCacheStats().coalesced, 2);
  } finally {
    await harness.close();
  }
});

test('a successful verification is replayed from the short-lived cache', async () => {
  clearVerifyCache();
  const harness = await startHarness();
  try {
    const first = await post(`${harness.url}/verify-telebirr`, { reference: 'CE2513002ABC' });
    assert.equal(first.headers.get('x-verify-cache'), null);
    await first.json();

    const second = await post(`${harness.url}/verify-telebirr`, { reference: 'CE2513002ABC' });
    assert.equal(second.headers.get('x-verify-cache'), 'hit');
    assert.equal(harness.calls(), 1, 'the cached response must not hit the handler again');
  } finally {
    await harness.close();
  }
});

test('failures are never cached', async () => {
  clearVerifyCache();
  const harness = await startHarness({
    handler: (_req, res) => {
      res.status(404).json({ success: false, error: 'Receipt not found or could not be processed.' });
    },
  });
  try {
    await post(`${harness.url}/verify-telebirr`, { reference: 'CE2513003DEF' });
    await post(`${harness.url}/verify-telebirr`, { reference: 'CE2513003DEF' });
    assert.equal(harness.calls(), 2, 'a 404 must be retried against the provider');
    assert.equal(verifyCacheStats().entries, 0);
  } finally {
    await harness.close();
  }
});

test('200 responses with success:false are not cached', async () => {
  clearVerifyCache();
  const harness = await startHarness({
    handler: (_req, res) => {
      res.json({ success: false, error: 'The transaction receipt number does not exist.' });
    },
  });
  try {
    await post(`${harness.url}/verify-telebirr`, { reference: 'CE2513004GHI' });
    await post(`${harness.url}/verify-telebirr`, { reference: 'CE2513004GHI' });
    assert.equal(harness.calls(), 2);
    assert.equal(verifyCacheStats().entries, 0);
  } finally {
    await harness.close();
  }
});

test('different endpoints never share a cached verification', async () => {
  clearVerifyCache();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).apiKeyData = { workspace: { id: 'ws_same' } };
    next();
  });
  const calls = { telebirr: 0, mpesa: 0 };
  app.use('/verify-telebirr', verifyResultCache);
  app.use('/verify-mpesa', verifyResultCache);
  app.post('/verify-telebirr', (_req, res) => {
    calls.telebirr += 1;
    res.json({ success: true, provider: 'telebirr' });
  });
  app.post('/verify-mpesa', (_req, res) => {
    calls.mpesa += 1;
    res.json({ success: true, provider: 'mpesa' });
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const t = await (await post(`${url}/verify-telebirr`, { reference: 'SAME-REF' })).json();
  const m = await (await post(`${url}/verify-mpesa`, { reference: 'SAME-REF' })).json();

  assert.equal(calls.telebirr, 1);
  assert.equal(calls.mpesa, 1, 'a Telebirr result must never answer a M-Pesa request');
  assert.equal(t.provider, 'telebirr');
  assert.equal(m.provider, 'mpesa');
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('different workspaces never share a cached verification', async () => {
  clearVerifyCache();
  const harness = await startHarness();
  try {
    const app = express();
    app.use(express.json());
    let calls = 0;
    let workspaceId = 'ws_a';
    app.use((req, _res, next) => {
      (req as any).apiKeyData = { workspace: { id: workspaceId } };
      next();
    });
    app.use('/verify-telebirr', verifyResultCache);
    app.post('/verify-telebirr', async (_req, res) => {
      calls += 1;
      res.json({ success: true, workspace: workspaceId });
    });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const first = await (await post(`${url}/verify-telebirr`, { reference: 'SHARED' })).json();
    workspaceId = 'ws_b';
    const second = await (await post(`${url}/verify-telebirr`, { reference: 'SHARED' })).json();

    assert.equal(calls, 2, 'each workspace must verify independently');
    assert.equal(first.workspace, 'ws_a');
    assert.equal(second.workspace, 'ws_b');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } finally {
    await harness.close();
  }
});
