/**
 * Tiny keep-alive HTTP client with per-request connection timings.
 * Uses node:http/https directly so it has zero dependencies and works on any
 * Node 18+ (GitHub runners, the Render container, a laptop).
 */
import http from 'node:http';
import https from 'node:https';

/**
 * AggregateError (Happy Eyeballs, DNS failures) often carries an empty
 * `message`, which made transport failures look like successes in an earlier
 * revision of this harness. Always produce something actionable.
 */
function describeError(err) {
  const code = err?.code ? `${err.code}` : '';
  if (err?.message) return code && !err.message.includes(code) ? `${code}: ${err.message}` : err.message;
  const nested = Array.isArray(err?.errors) ? err.errors.map((e) => describeError(e)).filter(Boolean).join('; ') : '';
  if (nested) return nested;
  return code || err?.constructor?.name || 'unknown transport error';
}

export function createClient({ baseUrl, maxSockets = 128, timeoutMs = 120_000 }) {
  const target = new URL(baseUrl);
  const secure = target.protocol === 'https:';
  const mod = secure ? https : http;

  const agent = new mod.Agent({
    keepAlive: true,
    maxSockets,
    maxFreeSockets: Math.min(maxSockets, 64),
    // Keep long-lived, warm connections; the load test wants to measure the
    // service, not a TCP/TLS handshake on every call.
    timeout: 0,
    scheduling: 'lifo',
  });

  let connectionsCreated = 0;
  let connectionsReused = 0;

  function request({
    method = 'GET',
    path = '/',
    headers = {},
    body = null,
    label = null,
    timeout = timeoutMs,
  } = {}) {
    return new Promise((resolve) => {
      const startedAt = process.hrtime.bigint();
      const ms = (from) => Number(process.hrtime.bigint() - from) / 1e6;

      const payload = body === null || body === undefined
        ? null
        : (typeof body === 'string' ? body : JSON.stringify(body));

      const finalHeaders = { ...headers };
      if (payload !== null && finalHeaders['content-type'] === undefined) {
        finalHeaders['content-type'] = 'application/json';
      }
      if (payload !== null && finalHeaders['content-length'] === undefined) {
        finalHeaders['content-length'] = Buffer.byteLength(payload);
      }

      const options = {
        agent,
        method,
        headers: { 'accept-encoding': 'identity', ...finalHeaders },
        // Never let a pooled socket silently die mid-request.
        timeout,
      };

      // `new URL(...)` is passed as the first argument rather than spread into
      // the options object: URL accessors (hostname/port/protocol) live on the
      // prototype, so an object spread silently drops them.
      const requestUrl = new URL(path, target);

      const result = {
        label,
        method,
        path,
        status: null,
        ok: false,
        error: null,
        errorCode: null,
        bytes: 0,
        bodySnippet: null,
        reusedConnection: null,
        ttfbMs: null,
        totalMs: null,
        connectMs: null,
        tlsMs: null,
        headers: {},
      };

      let settled = false;
      let deadline;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        result.totalMs = ms(startedAt);
        resolve(result);
      };

      const req = mod.request(requestUrl, options, (res) => {
        result.status = res.statusCode;
        result.headers = res.headers;
        result.ttfbMs = ms(startedAt);
        const chunks = [];
        res.on('data', (chunk) => {
          result.bytes += chunk.length;
          if (result.bytes <= 4096) chunks.push(chunk);
        });
        res.on('end', () => {
          result.ok = res.statusCode >= 200 && res.statusCode < 400;
          if (chunks.length) {
            result.bodySnippet = Buffer.concat(chunks).toString('utf8').slice(0, 2000);
          }
          finish();
        });
        res.on('error', (err) => {
          result.error = describeError(err);
          result.errorCode = err.code || 'RES_ERROR';
          finish();
        });
      });

      req.on('socket', (socket) => {
        result.reusedConnection = socket.connecting !== true;
        if (result.reusedConnection) {
          connectionsReused += 1;
        } else {
          connectionsCreated += 1;
          const socketAssignedAt = process.hrtime.bigint();
          socket.once('connect', () => {
            result.connectMs = ms(socketAssignedAt);
            if (secure) {
              const connectedAt = process.hrtime.bigint();
              socket.once('secureConnect', () => {
                result.tlsMs = ms(connectedAt);
              });
            }
          });
        }
      });

      // A wall-clock deadline includes socket queueing, DNS, TLS and body read.
      // Socket inactivity timeouts alone allow a slow trickle to run forever.
      const expire = () => {
        if (settled) return;
        result.error = `timeout after ${timeout}ms`;
        result.errorCode = 'ETIMEDOUT_LOCAL';
        req.destroy(Object.assign(new Error(result.error), { code: result.errorCode }));
        finish();
      };
      deadline = setTimeout(expire, timeout);
      req.on('timeout', expire);

      req.on('error', (err) => {
        result.error = describeError(err);
        result.errorCode = err.code || 'REQ_ERROR';
        if (result.ttfbMs === null) result.ttfbMs = ms(startedAt);
        finish();
      });

      if (payload !== null) req.write(payload);
      req.end();
    });
  }

  return {
    request,
    stats: () => ({ created: connectionsCreated, reused: connectionsReused }),
    close: () => agent.destroy(),
  };
}

/** Classify a response for reporting. */
export function classify(result) {
  if (result.errorCode === 'ETIMEDOUT_LOCAL') return 'client_timeout';
  if (result.status === null || result.status === undefined) {
    return result.errorCode === 'ETIMEDOUT_LOCAL' ? 'client_timeout' : 'network_error';
  }
  if (result.error) return 'network_error';
  const status = result.status;
  if (status === 429) return 'throttled_429';
  if (status === 402) return 'quota_402';
  if (status === 401) return 'unauthenticated_401';
  if (status === 403) return 'forbidden_403';
  if (status === 404) return 'not_found_404';
  if (status === 503) {
    const body = result.bodySnippet || '';
    if (body.includes('initializing')) return 'initializing_503';
    return 'unavailable_503';
  }
  if (status >= 500) return 'server_error_5xx';
  if (status >= 400) return 'client_error_4xx';
  return 'ok';
}

export const PROBLEM_CLASSES = new Set([
  'unexpected_status',
  'client_timeout',
  'network_error',
  'server_error_5xx',
  'unavailable_503',
  'initializing_503',
]);
