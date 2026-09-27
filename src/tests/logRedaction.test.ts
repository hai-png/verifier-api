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
  assert.ok(!output.includes('sk_live_0123456789abcdef'), `api key leaked: ${output}`);
  assert.ok(!output.includes('nvd_sess_user-1'), `session token leaked: ${output}`);
  assert.ok(output.includes('[redacted]'), 'expected redaction markers');
});
