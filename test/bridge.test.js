// -----------------------------------------------------------------------------
// The HTTP client of the bridge on real sockets (127.0.0.1): whether a
// request may have reached the bridge (`notSent`), beforeSend before the first
// byte, answers bounded in size and time, abort, errors without the query.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { ERROR_KINDS, bridgeRequest } from '../src/bridge.js';

async function server(t, handler) {
  const received = [];
  const srv = createServer((req, res) => {
    received.push(req.url);
    handler(req, res);
  });
  const sockets = new Set();
  srv.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => srv.close(resolve));
  });
  return { port: srv.address().port, received };
}

const base = (port, extra = {}) => ({
  host: '127.0.0.1',
  port,
  method: 'GET',
  path: '/status',
  timeout: 1000,
  json: true,
  ...extra,
});

test('a JSON answer; the headers Accept and Connection: close', async (t) => {
  let headers;
  const { port } = await server(t, (req, res) => {
    headers = req.headers;
    res.end('{"a":1}');
  });
  const answer = await bridgeRequest(base(port));
  assert.deepEqual(answer.json, { a: 1 });
  assert.equal(headers.accept, 'application/json');
  assert.equal(headers.connection, 'close');
});

test('beforeSend runs once connected; if it throws, not one byte is written (notSent)', async (t) => {
  const { port, received } = await server(t, (req, res) => res.end('{}'));
  let calls = 0;
  await assert.rejects(
    bridgeRequest(
      base(port, {
        beforeSend: () => {
          calls += 1;
          throw new Error('no');
        },
      }),
    ),
    (err) => err.kind === ERROR_KINDS.REFUSED && err.notSent === true,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  assert.deepEqual(received, []);
});

test('a refused connection is notSent; a silent bridge after the request is not', async (t) => {
  const closed = createTcpServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(
    bridgeRequest(base(port)),
    (err) => err.notSent === true && err.kind === ERROR_KINDS.NETWORK,
  );
  const silent = await server(t, () => {});
  await assert.rejects(
    bridgeRequest(base(silent.port, { timeout: 200 })),
    (err) => err.notSent === false && err.kind === ERROR_KINDS.TIMEOUT,
  );
});

test('stall: 1 s... here 100 ms without a byte cuts the answer', async (t) => {
  const { port } = await server(t, (req, res) => {
    res.writeHead(200);
    res.write('{"a":');
  });
  const started = performance.now();
  await assert.rejects(
    bridgeRequest(base(port, { timeout: 5000, stallMs: 100 })),
    (err) => err.kind === ERROR_KINDS.TIMEOUT,
  );
  assert.ok(performance.now() - started < 2000);
});

test('answers bounded: declared or streamed over the limit are cut', async (t) => {
  const declared = await server(t, (req, res) => {
    res.writeHead(200, { 'Content-Length': '99999' });
    res.write('x');
  });
  await assert.rejects(bridgeRequest(base(declared.port)), (e) => e.kind === ERROR_KINDS.SIZE);
  const streamed = await server(t, (req, res) => {
    res.writeHead(200);
    res.write('x'.repeat(10_000));
    res.end('x'.repeat(10_000));
  });
  await assert.rejects(bridgeRequest(base(streamed.port)), (e) => e.kind === ERROR_KINDS.SIZE);
});

test('HTTP errors keep the status and Retry-After, never the query; not JSON is a bad answer', async (t) => {
  const { port } = await server(t, (req, res) => {
    if (req.url.startsWith('/to_lock')) {
      res.writeHead(429, { 'Retry-After': '120' });
      res.end('slow down');
      return;
    }
    res.end('<html>');
  });
  await assert.rejects(
    bridgeRequest(base(port, { path: '/to_lock?command_signed_base64=SECRETSIG', json: false })),
    (err) =>
      err.kind === ERROR_KINDS.HTTP &&
      err.status === 429 &&
      err.retryAfter === 120 &&
      !err.message.includes('SECRETSIG'),
  );
  await assert.rejects(bridgeRequest(base(port)), (e) => e.kind === ERROR_KINDS.BAD_RESPONSE);
});

test('abort: at once, before or during the request', async (t) => {
  const { port } = await server(t, () => {});
  const controller = new AbortController();
  const pending = bridgeRequest(base(port, { timeout: 5000, signal: controller.signal }));
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, (e) => e.kind === ERROR_KINDS.ABORTED);
  const aborted = AbortSignal.abort();
  await assert.rejects(
    bridgeRequest(base(port, { signal: aborted })),
    (e) => e.kind === ERROR_KINDS.ABORTED && e.notSent,
  );
});
