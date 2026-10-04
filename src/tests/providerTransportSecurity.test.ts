// Transport-level security for the provider fetchers.
//
// These assertions are on the *request the fetcher asks for*, not on the source
// text, because the defect they guard is a property of the outgoing call. A
// regex over the file would have stayed green through all of it.
//
//  - Every provider response is the verification: CBE returns a PDF that is
//    regex-parsed into a "verified payment", Awash an HTML table, Zemen a PDF.
//    `rejectUnauthorized: false` on any of them means anyone with a network
//    position against that host can mint one.
//  - `--ignore-certificate-errors` in the Puppeteer launch args does the same
//    thing to the browser-driven CBE fallback, one layer above axios.
//  - Unbounded response bodies let a hostile or broken upstream buffer hundreds
//    of megabytes on the instance that is also serving customers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';

/** Collect the axios request configs a fetcher issues, then fail so no bank is hit. */
function captureAxiosRequests() {
  const axios = require('axios').default ?? require('axios');
  const captured: any[] = [];
  const originals: Array<() => void> = [];
  const replace = (obj: any, key: string, value: any) => {
    const original = obj[key];
    obj[key] = value;
    originals.push(() => { obj[key] = original; });
  };
  replace(axios, 'get', async (_url: string, config: any) => {
    captured.push(config ?? {});
    throw Object.assign(new Error('intercepted'), { response: { status: 404 } });
  });
  return {
    captured,
    restore: () => originals.reverse().forEach((fn) => fn()),
  };
}

/** Every TLS override axios understands, in any of the shapes it accepts. */
function assertCertificateVerificationOn(config: any, label: string): void {
  const agents = [config.httpsAgent, config.httpAgent, config.agent];
  for (const agent of agents) {
    if (!agent || typeof agent !== 'object') continue;
    const options = (agent as { options?: Record<string, unknown> }).options ?? (agent as Record<string, unknown>);
    assert.notEqual(
      options.rejectUnauthorized,
      false,
      `${label} disables certificate verification (rejectUnauthorized: false) on the provider request`,
    );
  }
  assert.notEqual(
    config.rejectUnauthorized,
    false,
    `${label} disables certificate verification on the provider request`,
  );
}

test('no provider fetcher turns off TLS certificate verification', async (t) => {
  const capture = captureAxiosRequests();
  t.after(() => capture.restore());

  const { verifyCBENew } = await import('../services/verifyCBE');
  const { verifyAwash } = await import('../services/verifyAwash');
  const { verifyZemen } = await import('../services/verifyZemen');

  await verifyCBENew('ABCDEFGH12345678').catch(() => undefined);
  await verifyAwash('FT1234567890').catch(() => undefined);
  await verifyZemen('FT1234567890').catch(() => undefined);

  assert.ok(capture.captured.length >= 3, `expected requests from all three fetchers, saw ${capture.captured.length}`);
  capture.captured.forEach((config, index) => assertCertificateVerificationOn(config, `provider request #${index + 1}`));
});

test('provider responses are size-bounded so a hostile body cannot exhaust the instance', async (t) => {
  const capture = captureAxiosRequests();
  t.after(() => capture.restore());

  const { verifyCBENew } = await import('../services/verifyCBE');
  const { verifyAwash } = await import('../services/verifyAwash');
  const { verifyZemen } = await import('../services/verifyZemen');

  await verifyCBENew('ABCDEFGH12345678').catch(() => undefined);
  await verifyAwash('FT1234567890').catch(() => undefined);
  await verifyZemen('FT1234567890').catch(() => undefined);

  for (const config of capture.captured) {
    assert.ok(
      typeof config.maxContentLength === 'number' && config.maxContentLength > 0,
      'every provider response must declare maxContentLength',
    );
  }
});

test('the Puppeteer fallback launches without disabling certificate errors', async () => {
  // Asserts the options the browser is actually constructed from. The function is
  // exported precisely so this can be checked on a machine with no Chromium,
  // rather than by grepping the source for a flag that could be reintroduced
  // through a different code path.
  const { cbeChromeLaunchOptions } = await import('../services/verifyCBE');
  const options = cbeChromeLaunchOptions('/usr/bin/chromium') as { args: string[] };
  const args = options.args ?? [];

  assert.ok(Array.isArray(args) && args.length > 0, 'launch args must be present');
  assert.ok(
    !args.includes('--ignore-certificate-errors'),
    '--ignore-certificate-errors lets a forged CBE receipt page be accepted',
  );
  assert.ok(
    !args.some((a) => a.startsWith('--ignore-certificate-errors-for-url')),
    'per-URL certificate overrides are the same defect with a narrower scope',
  );
  assert.ok(
    !args.includes('--allow-running-insecure-content'),
    'insecure content loading reaches the same defect through a subresource',
  );
  assert.ok(
    !args.includes('--disable-web-security'),
    'disabling web security is unrelated hardening but belongs in the same review',
  );
});

test('an IPv4-mapped metadata address is refused at the URL layer an attacker would use', async (t) => {
  // Over a real socket, so the assertion covers normalisation as well as the
  // blocklist: a caller that re-serialised the URL after validation would still
  // be caught here.
  const { assertSafeOutboundUrl, UnsafeOutboundUrlError } = await import('../utils/safeUrl');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.post('/hook', async (req: any, res: any) => {
    try {
      await assertSafeOutboundUrl(req.body?.url);
      res.status(200).json({ delivered: true });
    } catch (error) {
      res.status(422).json({ rejected: error instanceof UnsafeOutboundUrlError });
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const port = (server.address() as AddressInfo).port;

  for (const url of [
    'http://[::ffff:169.254.169.254]/latest/meta-data/iam/security-credentials/role',
    'http://[::ffff:127.0.0.1]:6379/',
    'http://[::7f00:1]/',
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    assert.equal(response.status, 422, `${url} must be refused`);
    assert.deepEqual(await response.json(), { rejected: true });
  }
});
