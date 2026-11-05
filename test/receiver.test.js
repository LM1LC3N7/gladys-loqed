// -----------------------------------------------------------------------------
// The `loqed-webhook` sub-container: the real HTTP service on the loopback
// and the real channel to a real client. Only the exact path with the token,
// POST, signed headers, bounded body, budget and connections; the bytes are
// handed over exactly (the signature covers them).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, createServer as createTcpServer } from 'node:net';
import { ChannelClient } from '../src/channel.js';
import { startWebhookService, isHookPath } from '../src/push/service.js';
import { waitFor, within } from './helpers/clock.js';

const TOKEN = 'T'.repeat(32);
const CHANNEL = 'K'.repeat(32);
const HEADERS = { TIMESTAMP: '1700000000', HASH: 'a'.repeat(64) };

async function start(t, env = {}) {
  const service = await startWebhookService({
    env: {
      WEBHOOK_TOKEN: TOKEN,
      CHANNEL_TOKEN: CHANNEL,
      HTTP_PORT: '0',
      HTTP_HOST: '127.0.0.1',
      CHANNEL_PORT: '0',
      ...env,
    },
  });
  const messages = [];
  const client = new ChannelClient({
    host: '127.0.0.1',
    port: service.channel.port,
    token: CHANNEL,
    delays: [20],
  });
  client.on('message', (m) => messages.push(m));
  t.after(async () => {
    client.stop();
    await service.stop();
  });
  const post = (path, { body = '{}', headers = HEADERS, method = 'POST' } = {}) =>
    fetch(`http://127.0.0.1:${service.port}${path}`, {
      method,
      body: method === 'GET' ? undefined : body,
      duplex: 'half',
      headers,
      signal: AbortSignal.timeout(3000),
    });
  return { service, client, messages, post };
}

test('path: exactly /loqed/<token>, compared in full', () => {
  assert.equal(isHookPath(`/loqed/${TOKEN}`, TOKEN), true);
  for (const url of [
    `/loqed/${TOKEN}?x=1`,
    `/loqed/${TOKEN}/`,
    `/loqed/${'T'.repeat(31)}U`,
    '/loqed/',
    `/LOQED/${TOKEN}`,
  ]) {
    assert.equal(isHookPath(url, TOKEN), false, url);
  }
  assert.equal(isHookPath(`/loqed/${TOKEN}`, ''), false);
});

test('a signed post reaches the main container byte for byte, kept while it is away', async (t) => {
  const { client, messages, post } = await start(t);
  const body = '{"event_type":"STATE_CHANGED_OPEN","x":"é"}';
  assert.equal((await post(`/loqed/${TOKEN}`, { body })).status, 200);
  client.start();
  await within(
    waitFor(() => messages.length === 1),
    4000,
  );
  const [msg] = messages;
  assert.equal(msg.type, 'webhook');
  assert.equal(Buffer.from(msg.body, 'base64').toString('utf8'), body);
  assert.equal(msg.timestamp, '1700000000');
  assert.equal(msg.hash, 'a'.repeat(64));
  assert.equal(msg.from, '127.0.0.1');
});

test('refused before the main container: wrong path, method, headers, size; another sender', async (t) => {
  const { client, messages, post } = await start(t);
  client.start();
  assert.equal((await post('/loqed/nope')).status, 404);
  assert.equal((await post(`/loqed/${TOKEN}`, { method: 'GET' })).status, 405);
  assert.equal((await post(`/loqed/${TOKEN}`, { headers: { HASH: HEADERS.HASH } })).status, 400);
  assert.equal(
    (await post(`/loqed/${TOKEN}`, { headers: { ...HEADERS, HASH: 'zz' } })).status,
    400,
  );
  assert.equal((await post(`/loqed/${TOKEN}`, { body: 'x'.repeat(5000) })).status, 413);
  // Streamed (chunked, no length announced): cut at 4 KB all the same.
  const chunked = await post(`/loqed/${TOKEN}`, {
    body: new ReadableStream({
      start(controller) {
        for (let i = 0; i < 5; i += 1)
          controller.enqueue(new TextEncoder().encode('x'.repeat(1000)));
        controller.close();
      },
    }),
  }).catch((err) => ({ status: err.name }));
  assert.ok(chunked.status === 413 || chunked.status === 'TypeError', String(chunked.status));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(messages.length, 0);
  const other = await start(t, { DEVICE_ADDRESS: '192.168.1.50' });
  other.client.start();
  await within(
    waitFor(() => other.client.connected),
    4000,
  );
  assert.equal((await other.post(`/loqed/${TOKEN}`)).status, 403);
  await within(
    waitFor(() => other.messages.length === 1),
    4000,
  );
  assert.equal(other.messages[0].type, 'refused');
  assert.equal(other.messages[0].body, undefined);
});

test('budget: 30 posts a minute from a source that is not the bridge', async (t) => {
  const { post } = await start(t);
  const codes = [];
  for (let i = 0; i < 32; i += 1) codes.push((await post(`/loqed/${TOKEN}`)).status);
  assert.equal(codes.filter((c) => c === 200).length, 30);
  assert.equal(codes.at(-1), 429);
});

test('connections: 4 silent ones per source at most, the oldest silent one closed for a newcomer', async (t) => {
  const { service } = await start(t);
  const sockets = [];
  const closed = [];
  for (let i = 0; i < 6; i += 1) {
    const socket = connect(service.port, '127.0.0.1');
    socket.on('error', () => {});
    socket.on('close', () => closed.push(i));
    sockets.push(socket);
    await new Promise((resolve) => socket.once('connect', resolve));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await within(
    waitFor(() => closed.length >= 2),
    4000,
  );
  assert.deepEqual(closed.slice(0, 2).sort(), [0, 1]);
  for (const socket of sockets) socket.destroy();
});

test('the channel refuses a client without the secret', async (t) => {
  const { service, messages } = await start(t);
  const intruder = new ChannelClient({
    host: '127.0.0.1',
    port: service.channel.port,
    token: 'X'.repeat(32),
    delays: [1000],
  });
  let up = false;
  intruder.on('up', () => (up = true));
  intruder.start();
  t.after(() => intruder.stop());
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(up, false);
  assert.equal(messages.length, 0);
});

/** JSON lines of a raw socket. */
function lines(socket) {
  const got = [];
  let rest = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    rest += chunk;
    let i;
    while ((i = rest.indexOf('\n')) >= 0) {
      got.push(JSON.parse(rest.slice(0, i)));
      rest = rest.slice(i + 1);
    }
  });
  return got;
}

test('m2: the channel server gives nothing (no ready, no queue) for a wrong proof', async (t) => {
  const { service, post } = await start(t);
  assert.equal((await post(`/loqed/${TOKEN}`)).status, 200); // one webhook queued
  const socket = connect(service.channel.port, '127.0.0.1');
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  const got = lines(socket);
  await within(
    waitFor(() => got.length === 1),
    3000,
  );
  assert.equal(got[0].type, 'challenge');
  socket.write(
    `${JSON.stringify({ type: 'hello', nonce: 'a'.repeat(32), proof: 'f'.repeat(64) })}\n`,
  );
  await within(new Promise((resolve) => socket.once('close', resolve)), 3000, 'closed');
  assert.equal(got.length, 1, 'neither ready nor the queued webhook');
});

test('m2: the channel client accepts nothing from a server without the secret', async (t) => {
  const server = createTcpServer((socket) => {
    socket.on('error', () => {});
    socket.write(`${JSON.stringify({ type: 'challenge', nonce: 'b'.repeat(32) })}\n`);
    socket.on('data', () => {
      socket.write(`${JSON.stringify({ type: 'ready', proof: 'e'.repeat(64) })}\n`);
      socket.write(`${JSON.stringify({ type: 'webhook', body: 'e30=' })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new ChannelClient({
    host: '127.0.0.1',
    port: server.address().port,
    token: CHANNEL,
    delays: [5000],
  });
  const events = [];
  client.on('up', () => events.push('up'));
  client.on('message', () => events.push('message'));
  t.after(async () => {
    client.stop();
    await new Promise((resolve) => server.close(resolve));
  });
  client.start();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(events, []);
});
