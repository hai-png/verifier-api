// verifyImage used `multer({ dest: "uploads/" })` with no limits. The 100 kB
// express.json() cap does not apply to multipart/form-data, so multer streamed
// an arbitrarily large body to disk and readFileSync then held it plus its 1.33x
// base64 expansion in memory — an instant OOM on the 512 MB instance that
// killed every in-flight verification with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { AddressInfo } from 'node:net';
import { verifyImageHandler } from '../services/verifyImage';

// The upload middleware and its error translator, without the handler that
// needs a workspace and image credits.
const [uploadMiddleware, uploadErrorHandler] = verifyImageHandler as any[];

async function post(url: string, filename: string, type: string, bytes: number) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type }), filename);
  const response = await fetch(url, { method: 'POST', body: form });
  return { status: response.status, body: await response.text() };
}

test('image uploads are bounded by size and type', async (t) => {
  const app = express();
  app.post('/', uploadMiddleware, uploadErrorHandler, (_req, res) => { res.json({ ok: true }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => setImmediate(r));
  });

  // A plausible receipt is accepted.
  const ok = await post(url, 'receipt.png', 'image/png', 2048);
  assert.equal(ok.status, 200, `expected acceptance, got ${ok.status} ${ok.body}`);

  // Non-image content is rejected instead of being buffered and sent to Mistral.
  for (const type of ['text/plain', 'application/pdf', 'application/octet-stream']) {
    const response = await post(url, 'payload.bin', type, 1024);
    assert.equal(response.status, 415, `expected 415 for ${type}, got ${response.status}`);
  }

  // Anything over the cap is refused with 413, not a 500 and not an OOM.
  const oversized = await post(url, 'huge.png', 'image/png', 9 * 1024 * 1024);
  assert.equal(oversized.status, 413, `expected 413, got ${oversized.status} ${oversized.body.slice(0, 120)}`);
  assert.match(oversized.body, /too large/i);
});
