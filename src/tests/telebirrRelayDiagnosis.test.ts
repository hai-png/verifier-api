// A production Telebirr failure reported only "The fallback relay is unreachable
// or timed out" with "timeout of 18000ms exceeded". That is useless: the relay
// answered an unauthenticated request in 136ms, so the 18s was the relay's own
// upstream fetch, and the message could not distinguish that from DNS failure,
// a dead host, or a routing problem. Separately, when every relay is in
// circuit-open cooldown the pool returned null, which the route reports as
// "receipt not found" — a false statement to the customer, since no
// verification was ever attempted.
//
// A later failure of the same shape ("did not respond within 18000ms", naming
// the upstream fetch as the slow hop) turned out to be the budget stack rather
// than the network: the provider answered in 93ms and the relay answered a 401 in
// 26ms, but the relay's own post-fetch extraction ran unbounded and overran the
// API's deadline, so the API saw no bytes and blamed a hop the evidence cleared.
// The tests below pin both halves of that: the diagnosis must not guess a stage,
// and a per-attempt budget must not be able to swallow the pool budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { TelebirrVerificationError, verifyTelebirr } from '../services/verifyTelebirr';

const RELAY = 'https://relay.example.com/verify.php';
const REFERENCE = 'CE2513001XYT';

const ENV_KEYS = [
  'FALLBACK_PROXIES', 'TELEBIRR_PROXY_KEY', 'SKIP_PRIMARY_VERIFICATION',
  'TELEBIRR_PROXY_TIMEOUT_MS', 'TELEBIRR_TOTAL_TIMEOUT_MS',
  'TELEBIRR_PROXY_COOLDOWN_MS', 'TELEBIRR_PROXY_FAILURE_THRESHOLD',
  'TELEBIRR_HEDGE_DELAY_MS', 'TELEBIRR_MAX_PARALLEL_PROXIES',
];

/** verifyTelebirr reads process.env directly, so set and restore it per test. */
function useEnv(t: any, overrides: Record<string, string> = {}) {
  const previous: Record<string, string | undefined> = {};
  const values: Record<string, string> = {
    FALLBACK_PROXIES: RELAY,
    TELEBIRR_PROXY_KEY: 'relay-test-key',
    SKIP_PRIMARY_VERIFICATION: 'true',
    TELEBIRR_PROXY_TIMEOUT_MS: '120',
    TELEBIRR_TOTAL_TIMEOUT_MS: '300',
    TELEBIRR_PROXY_COOLDOWN_MS: '5000',
    TELEBIRR_PROXY_FAILURE_THRESHOLD: '1',
    TELEBIRR_HEDGE_DELAY_MS: '50',
    TELEBIRR_MAX_PARALLEL_PROXIES: '1',
    ...overrides,
  };
  for (const key of ENV_KEYS) {
    previous[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  t.after(() => {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key]!;
    }
  });
}

function transportError(code: string, message = `timeout of 120ms exceeded`): any {
  const error: any = new Error(message);
  error.code = code;
  error.isAxiosError = true;
  return error;
}

async function withStubbedAxios<T>(impl: (url: string) => Promise<any>, run: () => Promise<T>): Promise<T> {
  const original = axios.get;
  (axios as any).get = impl;
  try {
    return await run();
  } finally {
    (axios as any).get = original;
  }
}

test('a relay timeout names the relay without guessing which relay stage stalled', async (t) => {
  useEnv(t);
  await withStubbedAxios(
    async () => { throw transportError('ECONNABORTED'); },
    async () => {
      await assert.rejects(
        () => verifyTelebirr(REFERENCE),
        (error: unknown) => {
          assert.ok(error instanceof TelebirrVerificationError);
          // Must not be the old undifferentiated sentence.
          assert.ok(!/unreachable or timed out/.test(error.message),
            `message is still ambiguous: ${error.message}`);
          assert.match(error.message, /did not respond within 120ms/);
          // The details must carry enough to act on.
          assert.match(String(error.details), /relay=/);
          assert.match(String(error.details), /host=relay\.example\.com/);
          assert.match(String(error.details), /code=ECONNABORTED/);
          assert.match(String(error.details), /timeoutMs=120/);
          return true;
        },
      );
    },
  );
});

test('the timeout diagnosis does not assert a single relay stage it cannot observe', async (t) => {
  // A later incident showed the previous wording was wrong. It claimed the stall
  // was "the relay's own upstream provider fetch", but the provider answered in
  // under 100ms: the relay was slow in its own post-fetch DOM extraction, ran
  // past the API's deadline, and the client saw no bytes at all. A late response
  // and no response are indistinguishable here, so naming one stage is a guess.
  useEnv(t);
  await withStubbedAxios(
    async () => { throw transportError('ECONNABORTED'); },
    async () => {
      await assert.rejects(
        () => verifyTelebirr(REFERENCE),
        (error: unknown) => {
          assert.ok(error instanceof TelebirrVerificationError);
          const details = String(error.details);
          assert.ok(!/the slow hop is the relay's own upstream provider fetch/.test(details),
            `details still assert the upstream fetch as the slow hop: ${details}`);
          assert.match(details, /inside the relay/);
          // Both candidate stages must remain on the table.
          assert.match(details, /upstream provider fetch/);
          assert.match(details, /receipt parsing/);
          return true;
        },
      );
    },
  );
});

test('a per-attempt timeout at or above the pool total is clamped so the deadline can fire', async (t) => {
  // The production failure: 18s per attempt against a 20s pool. The attempt always
  // won the race, so the pool deadline was unreachable, and the reported timeoutMs
  // was the whole budget rather than a slice of it.
  useEnv(t, { TELEBIRR_PROXY_TIMEOUT_MS: '5000', TELEBIRR_TOTAL_TIMEOUT_MS: '300' });

  await withStubbedAxios(
    async () => { throw transportError('ECONNABORTED'); },
    async () => {
      await assert.rejects(
        () => verifyTelebirr(REFERENCE),
        (error: unknown) => {
          assert.ok(error instanceof TelebirrVerificationError);
          const details = String(error.details);
          // The reported budget must be a slice of the pool, not the whole of it.
          // The pool additionally trims to the time actually remaining, so allow a
          // small delta rather than pinning an exact millisecond.
          const reported = /timeoutMs=(\d+)/.exec(details);
          assert.ok(reported, `no timeoutMs in details: ${details}`);
          const attemptMs = Number(reported![1]);
          assert.ok(attemptMs < 300,
            `per-attempt budget should be clamped below the 300ms pool total: ${details}`);
          assert.ok(attemptMs > 0,
            `per-attempt budget must not collapse to zero: ${details}`);
          return true;
        },
      );
    },
  );
});

test('DNS, refusal and routing failures are reported distinctly', async (t) => {
  useEnv(t);
  const cases: Array<[string, RegExp]> = [
    ['ENOTFOUND', /hostname could not be resolved/i],
    ['ECONNREFUSED', /refused the connection/i],
    ['ENETUNREACH', /unreachable from the API/i],
    ['ECONNRESET', /reset the connection/i],
  ];
  for (const [code, expected] of cases) {
    await withStubbedAxios(
      async () => { throw transportError(code); },
      async () => {
        await assert.rejects(
          () => verifyTelebirr(REFERENCE),
          (error: unknown) => {
            assert.ok(error instanceof TelebirrVerificationError);
            assert.match(error.message, expected, `code ${code} produced: ${error.message}`);
            return true;
          },
        );
      },
    );
  }
});

test('a missing relay is reported as a configuration error, not "receipt not found"', async (t) => {
  useEnv(t, { FALLBACK_PROXIES: '' });

  let thrown: unknown;
  await withStubbedAxios(
    async () => { throw new Error('must not be called with no relay configured'); },
    async () => {
      try {
        await verifyTelebirr(REFERENCE);
      } catch (error) {
        thrown = error;
      }
    },
  );

  assert.ok(thrown instanceof TelebirrVerificationError,
    'a missing relay configuration must raise a transport error, not return null');
  assert.match((thrown as TelebirrVerificationError).message, /not configured/);
  assert.match((thrown as TelebirrVerificationError).message, /FALLBACK_PROXIES/);
  assert.equal((thrown as TelebirrVerificationError).kind, 'transport');
});

test('a cooling-down relay still gets a half-open attempt rather than failing closed', async (t) => {
  // The pool deliberately never returns zero candidates: stale circuit state
  // must not make a recovered relay permanently unreachable.
  useEnv(t, { TELEBIRR_PROXY_COOLDOWN_MS: '5000', TELEBIRR_PROXY_FAILURE_THRESHOLD: '1' });

  await withStubbedAxios(
    async () => { throw transportError('ECONNABORTED'); },
    async () => { await verifyTelebirr(REFERENCE).catch(() => undefined); },
  );

  let calls = 0;
  await withStubbedAxios(
    async () => { calls += 1; throw transportError('ECONNABORTED'); },
    async () => { await verifyTelebirr(REFERENCE).catch(() => undefined); },
  );

  assert.equal(calls, 1,
    'the breaker must allow one half-open recovery attempt, not block the relay outright');
});
