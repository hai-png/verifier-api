// requestLogger ran before /auth and apiKeyAuth and logged the full request body
// and query string, so POST /auth/login wrote plaintext passwords to stdout (and
// to the rotating files whenever LOG_TO_FILES was on) and ?adminKey= / ?apiKey=
// were recorded verbatim. Redaction is applied in the shared winston pipeline so
// it covers the Console transport, not just the file transports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createLogger, format, transports } from 'winston';

test('a login body never reaches the log stream', async (t) => {
  const previousLogBodies = process.env.LOG_REQUEST_BODIES;
  delete process.env.LOG_REQUEST_BODIES;
  t.after(() => {
    if (previousLogBodies === undefined) delete process.env.LOG_REQUEST_BODIES;
    else process.env.LOG_REQUEST_BODIES = previousLogBodies;
  });

  const { requestLogger } = await import('../middleware/requestLogger');

  // Drive the real middleware, then assert on what it hands the logger.
  const captured: any[] = [];
  const logger: any = (await import('../utils/logger')).default;
  const originalInfo = logger.info;
  logger.info = (message: string, meta?: unknown) => { captured.push({ message, meta }); };
  t.after(() => { logger.info = originalInfo; });

  const run = async (req: any) => new Promise<void>((resolve) => {
    requestLogger(req, { on() {}, statusCode: 200 } as any, () => resolve());
  });
  const baseReq = {
    headers: { 'user-agent': 'test' },
    get: () => 'test-agent',
    socket: { remoteAddress: '127.0.0.1' },
    ip: '127.0.0.1',
  };

  await run({
    ...baseReq,
    method: 'POST', originalUrl: '/auth/login?next=%2Fdashboard',
    body: { email: 'victim@example.com', password: 'hunter2-correct-horse' },
    query: { next: '/dashboard' },
  });
  await run({
    ...baseReq,
    method: 'POST', originalUrl: '/verify-cbe',
    body: { reference: 'FT2513001V2G', accountSuffix: '39003377' },
    query: {},
  });

  const serialised = JSON.stringify(captured);
  assert.ok(!serialised.includes('hunter2-correct-horse'), 'password must not be logged');
  assert.ok(!serialised.includes('victim@example.com'), 'credentials in the body must not be logged');
  assert.ok(!serialised.includes('next'), 'query string must not be logged');
  // The query string is stripped from the logged URL as well.
  assert.ok(!captured[0].message.includes('?'), 'logged URL must not contain the query string');
  assert.ok(captured[1].message.includes('/verify-cbe'), 'path is still logged');
});

test('the shared pipeline redacts credential-shaped metadata on every transport', async () => {
  // Mirrors the formats in src/utils/logger.ts: redaction runs before both the
  // emoji (console) and plain (file) renderers.
  const { default: logger } = await import('../utils/logger');
  const chunks: string[] = [];
  const original = logger.transports.map((transport) => transport);
  for (const transport of original) logger.remove(transport);
  logger.add(new transports.Stream({
    stream: new Writable({ write(chunk, _e, cb) { chunks.push(chunk.toString()); cb(); } }) as any,
  }));
  try {
    logger.info('login attempt', {
      body: { email: 'victim@example.com', password: 'hunter2-correct-horse' },
      // Synthetic and deliberately not key-shaped: GitHub push protection blocks
      // any commit containing a string that matches a live credential prefix.
      query: { apiKey: 'sk_live_not-a-real-key-used-only-in-tests' },
      url: '/auth/login',
    });
    logger.info('session issued', { token: 'nvd_sess_user-1.abcdef.deadbeef' });
    await new Promise<void>((r) => setImmediate(r));
  } finally {
    for (const transport of logger.transports) logger.remove(transport);
    for (const transport of original) logger.add(transport);
  }

  const output = chunks.join('\n');
  assert.ok(!output.includes('hunter2-correct-horse'), `password leaked: ${output}`);
  assert.ok(!output.includes('sk_live_not-a-real-key'), `api key leaked: ${output}`);
  assert.ok(!output.includes('nvd_sess_user-1'), `session token leaked: ${output}`);
  assert.ok(output.includes('[redacted]'), 'expected redaction markers');
});

test('a credential inside a serialised string is redacted, not only object keys', async () => {
  // The regression. `redactSerialized` ran the *value-shaped* patterns
  // (`sk_live_…`, `nvd_sess_…`, `Bearer …`) over a string, but never the
  // *key-shaped* one — and `SENSITIVE_KEY_PATTERN` only ever ran over object keys.
  // requestLogger logs bodies as `body: JSON.stringify(req.body)`, so with
  // LOG_REQUEST_BODIES on, a POST /auth/login body was written to
  // logs/combined-*.log with the plaintext password intact. The note in
  // logger.ts claiming redaction was fixed for request bodies was true for
  // structured metadata and false for the serialised bodies bodies actually
  // arrive as.
  const { default: logger } = await import('../utils/logger');
  const chunks: string[] = [];
  const original = logger.transports.map((transport) => transport);
  for (const transport of original) logger.remove(transport);
  logger.add(new transports.Stream({
    stream: new Writable({ write(chunk, _e, cb) { chunks.push(chunk.toString()); cb(); } }) as any,
  }));
  try {
    logger.info('incoming', {
      body: JSON.stringify({ email: 'victim@example.com', password: 'correct-horse-battery-staple' }),
    });
    logger.info('incoming', {
      query: 'redirect=https%3A%2F%2Fx&token=abc123secret&api_key=sk_live_zzz',
    });
    await new Promise<void>((r) => setImmediate(r));
  } finally {
    for (const transport of logger.transports) logger.remove(transport);
    for (const transport of original) logger.add(transport);
  }

  const output = chunks.join('\n');
  assert.ok(!output.includes('correct-horse-battery-staple'), `password in a serialised body leaked: ${output}`);
  assert.ok(!output.includes('abc123secret'), `token= in a query string leaked: ${output}`);
  assert.ok(!output.includes('sk_live_zzz'), `api_key= in a query string leaked: ${output}`);
  // Non-sensitive fields survive, or the log becomes useless for debugging.
  assert.ok(output.includes('victim@example.com'), 'unrelated fields should still be logged');
});
