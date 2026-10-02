// Two configuration mistakes that both fail silently, and both shipped once.
//
// 1. The keep-alive pinger used `RENDER_EXTERNAL_URL || VERITAS_APP_URL`. Once
//    VERITAS_APP_URL was pointed at the dashboard — which it has to be, because
//    every link built from it is a frontend page — the fallback aimed the ping
//    at Cloudflare Pages. That host answers 404 on /ready, so the pinger was
//    reporting a working keep-alive while generating zero traffic against
//    Render, and a free instance would idle out. The status page made it worse
//    by reporting keepAliveUrlConfigured: true, because it had drifted onto
//    reading the same two variables independently.
//
// 2. Neither BullMQ queue set a retryStrategy, so ioredis used its own default
//    (min(times * 50, 2000)). A REDIS_URL pointing at a host that does not
//    resolve was retried about once a second, four times over (a Queue and a
//    Worker per queue), each attempt logging.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePublicApiUrl } from '../config/publicApiUrl';
import { createRedisConnectionOptions } from '../queues/redisConnection';

function withEnv(t: any, vars: Record<string, string | undefined>) {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('VERITAS_APP_URL alone must not resolve the API URL', (t) => {
  withEnv(t, {
    RENDER_EXTERNAL_URL: undefined,
    VERITAS_APP_URL: 'https://dashboard.noveld.com.et',
  });

  // The regression: this used to return the dashboard, and the pinger followed
  // it there. An empty string disables the pinger, which is the safe outcome.
  assert.equal(resolvePublicApiUrl(), '');
});

test('the API URL comes from RENDER_EXTERNAL_URL, ignoring VERITAS_APP_URL', (t) => {
  withEnv(t, {
    RENDER_EXTERNAL_URL: 'https://verify.noveld.com.et',
    VERITAS_APP_URL: 'https://dashboard.noveld.com.et',
  });

  assert.equal(resolvePublicApiUrl(), 'https://verify.noveld.com.et');
});

test('a trailing slash cannot turn /ready into //ready', (t) => {
  withEnv(t, {
    RENDER_EXTERNAL_URL: 'https://verify.noveld.com.et/',
    VERITAS_APP_URL: undefined,
  });

  assert.equal(resolvePublicApiUrl(), 'https://verify.noveld.com.et');
  assert.equal(`${resolvePublicApiUrl()}/ready`, 'https://verify.noveld.com.et/ready');
});

test('Redis retries back off and then stop hammering', (t) => {
  withEnv(t, { REDIS_URL: 'rediss://default:pw@dead-host.upstash.io:6379' });

  // ConnectionOptions is a union with ClusterOptions, which has no
  // retryStrategy. This helper always builds a single-node connection.
  const options = createRedisConnectionOptions('webhook') as unknown as {
    retryStrategy: (times: number) => number;
  };
  const retryStrategy = options.retryStrategy;

  // Fast first, so a brief blip is still ridden out...
  assert.equal(retryStrategy(1), 200);
  assert.ok(retryStrategy(2) > retryStrategy(1), 'delay must grow');

  // ...then capped, so a host that stays wrong stops costing anything. The old
  // default held at 2000ms, which is roughly the once-per-second log line.
  assert.equal(retryStrategy(500), 30_000);
  assert.equal(retryStrategy(100_000), 30_000);
});

test('a missing REDIS_URL still fails loudly rather than silently', (t) => {
  withEnv(t, { REDIS_URL: undefined });

  assert.throws(
    () => createRedisConnectionOptions('webhook'),
    /REDIS_URL is required/,
  );
});
