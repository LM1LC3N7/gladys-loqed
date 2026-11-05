// -----------------------------------------------------------------------------
// HTTP client of the LOQED bridge (plain HTTP, port 80): one connection per
// request (`Connection: close`, never a pipeline), every answer bounded in
// size and in time.
//
// - `beforeSend()` runs synchronously once the connection is open, right
//   before the first byte of the request leaves: a command checks its last
//   conditions there (and numbers itself). If it throws, nothing is written.
// - every error says whether the request may have reached the bridge:
//   `notSent` is true only when not one byte of it was written.
// - a read that stays `stallMs` without a byte (from the bridge) is cut.
// - `signal` aborts at once (a lock that goes cancels the reads in flight).
//
// Nothing here logs; error messages never hold a query string (a signed
// command) nor a header.
// -----------------------------------------------------------------------------

import { request as httpRequest } from 'node:http';
import { LIMITS } from './constants.js';

export const ERROR_KINDS = {
  NETWORK: 'network',
  TIMEOUT: 'timeout',
  ABORTED: 'aborted',
  REFUSED: 'refused',
  SIZE: 'size',
  HTTP: 'http',
  BAD_RESPONSE: 'bad_response',
};

export class BridgeError extends Error {
  constructor(kind, message, { notSent = false, status, retryAfter, cause } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.kind = kind;
    this.notSent = notSent;
    this.status = status;
    this.retryAfter = retryAfter;
    if (cause) this.cause = cause;
  }
}

/** Retry-After in seconds (a number only); undefined otherwise. */
function retryAfterOf(value) {
  return typeof value === 'string' && /^\d{1,6}$/.test(value.trim())
    ? Number(value.trim())
    : undefined;
}

/**
 * One request. Resolves `{ status, body: Buffer, json? }` for a 2xx answer;
 * rejects a BridgeError otherwise.
 *
 * @param {object} o
 * @param {string} o.host
 * @param {number} o.port
 * @param {string} o.method
 * @param {string} o.path   path and query (the query may hold a signed command)
 * @param {object} [o.headers]
 * @param {string} [o.body]
 * @param {number} o.timeout  whole request, from the call
 * @param {number} [o.stallMs]  at most this long without a byte once the request left
 * @param {() => void} [o.beforeSend]
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.maxBytes]
 * @param {boolean} [o.json]  parse the body as JSON
 * @param {object} [o.timers]
 */
export function bridgeRequest({
  host,
  port,
  method,
  path,
  headers = {},
  body,
  timeout,
  stallMs,
  beforeSend,
  signal,
  maxBytes = LIMITS.responseBytes,
  json = false,
  timers = globalThis,
}) {
  if (signal?.aborted) {
    return Promise.reject(new BridgeError(ERROR_KINDS.ABORTED, 'Aborted', { notSent: true }));
  }
  return new Promise((resolve, reject) => {
    let sent = false;
    let done = false;
    let stall;
    const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
    const req = httpRequest({
      host,
      port,
      method,
      path,
      agent: false,
      setHost: true,
      headers: {
        Accept: 'application/json',
        Connection: 'close',
        ...(payload
          ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
          : {}),
        ...headers,
      },
    });
    const finish = (err, value) => {
      if (done) return;
      done = true;
      timers.clearTimeout(deadline);
      timers.clearTimeout(stall);
      signal?.removeEventListener('abort', onAbort);
      if (err) {
        req.destroy();
        reject(err);
      } else {
        resolve(value);
      }
    };
    const fail = (kind, message, extra = {}) =>
      finish(new BridgeError(kind, message, { notSent: !sent, ...extra }));
    const armStall = () => {
      if (!stallMs) return;
      timers.clearTimeout(stall);
      stall = timers.setTimeout(() => fail(ERROR_KINDS.TIMEOUT, 'No answer'), stallMs);
    };
    const deadline = timers.setTimeout(
      () => fail(ERROR_KINDS.TIMEOUT, sent ? 'No answer' : 'Could not connect'),
      timeout,
    );
    const onAbort = () => fail(ERROR_KINDS.ABORTED, 'Aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('socket', (socket) => {
      socket.once('connect', () => {
        if (done) return;
        try {
          beforeSend?.();
        } catch (err) {
          finish(new BridgeError(ERROR_KINDS.REFUSED, 'Not sent', { notSent: true, cause: err }));
          return;
        }
        sent = true;
        armStall();
        req.end(payload);
      });
    });
    req.on('error', (err) =>
      fail(ERROR_KINDS.NETWORK, `Network error (${err?.code ?? 'unknown'})`),
    );
    req.on('response', (res) => {
      armStall();
      const status = res.statusCode ?? 0;
      const declared = res.headers['content-length'];
      if (declared !== undefined && (!/^\d{1,9}$/.test(declared) || Number(declared) > maxBytes)) {
        fail(ERROR_KINDS.SIZE, 'Answer too large', { status });
        return;
      }
      const parts = [];
      let size = 0;
      res.on('data', (chunk) => {
        if (done) return;
        armStall();
        size += chunk.length;
        if (size > maxBytes) {
          fail(ERROR_KINDS.SIZE, 'Answer too large', { status });
          return;
        }
        parts.push(chunk);
      });
      res.on('error', () => fail(ERROR_KINDS.NETWORK, 'Answer cut'));
      res.on('aborted', () => fail(ERROR_KINDS.NETWORK, 'Answer cut'));
      res.on('end', () => {
        if (done) return;
        const bytes = Buffer.concat(parts, size);
        if (status < 200 || status > 299) {
          fail(ERROR_KINDS.HTTP, `HTTP ${status}`, {
            status,
            retryAfter: retryAfterOf(res.headers['retry-after']),
          });
          return;
        }
        if (!json) {
          finish(undefined, { status, body: bytes });
          return;
        }
        try {
          finish(undefined, { status, body: bytes, json: JSON.parse(bytes.toString('utf8')) });
        } catch {
          fail(ERROR_KINDS.BAD_RESPONSE, 'Not JSON', { status });
        }
      });
    });
    // Nothing is written before the connection is open and beforeSend agreed:
    // req.end() is called from the `connect` handler above.
  });
}
