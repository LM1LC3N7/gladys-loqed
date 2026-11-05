// -----------------------------------------------------------------------------
// The service of the `loqed-webhook` sub-container: the HTTP endpoint the
// LOQED bridge posts its events to (the URL of its webhook), and the channel
// that hands each event to the main container. The main container cannot
// publish a port; this container does (Gladys picks the host port).
//
// Accepted: exactly `POST /loqed/<webhook token>` (no query string) with a
// TIMESTAMP and a HASH header, a body of 4 KB at most. Everything else is
// answered 404 (405 for another method on the right path, 400 without the
// headers, 413 for a body too large, 429 over the rate) and never reaches the
// main container. The token keeps another machine of the network from posting
// by guessing the URL (it travels in clear, over HTTP); the main container
// then checks the signature of the bridge (HASH, made with the bridge key,
// which never enters this container), the time and the source address.
//
// Bounded for a 64 MB container: 16 connections at most, 4 per source
// address, 4 kept for DEVICE_ADDRESS when set; over a limit the OLDEST
// connection whose request is not complete is closed, never the newcomer from
// the bridge. A connection that sends nothing is closed within 10 s, the
// headers must arrive within 5 s and the whole request within 10 s (checked
// every second). 120 posts a minute in all; the bridge (DEVICE_ADDRESS) has
// that whole budget, any other source 30 of it. When DEVICE_ADDRESS is set
// ("Check the sender" on), a post from another address is answered 403 before
// any budget is spent, and the main container is told (at most every 10 s),
// never with its body.
//
// Environment, set by the main container through startContainer:
//   WEBHOOK_TOKEN  the secret of the webhook URL
//   CHANNEL_TOKEN  the secret the main container says hello with
//   HTTP_PORT      8080 (published by Gladys)
//   CHANNEL_PORT   7779 (private network only)
//   DEVICE_ADDRESS the IP address of the bridge, when the sender is checked
// -----------------------------------------------------------------------------

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createChannelServer } from '../channel.js';
import { LIMITS, RECEIVER } from '../constants.js';
import { isToken, normalizeIp } from '../config.js';

const PATH = /^\/loqed\/([A-Za-z0-9_-]{32,128})$/;
const TIMESTAMP = /^\d{1,12}$/;
const HASH = /^[0-9a-fA-F]{64}$/;

const sameToken = (a, b) => {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
};

/** Whether a request target is exactly the webhook path with the right token. */
export function isHookPath(url, token) {
  if (!isToken(token) || typeof url !== 'string') {
    return false;
  }
  const match = PATH.exec(url);
  return Boolean(match) && sameToken(match[1], token);
}

const reply = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'text/plain', Connection: 'close' }).end(body);
};

/**
 * @returns {Promise<{ http, channel, stop(): Promise, port: number }>}
 */
export async function startWebhookService({
  env = process.env,
  logger,
  now = Date.now,
  monotonic = () => performance.now(),
} = {}) {
  const token = env.WEBHOOK_TOKEN ?? '';
  if (!isToken(token)) {
    logger?.warn('WEBHOOK_TOKEN is missing: every webhook will be refused');
  }
  const channel = createChannelServer({
    port: Number(env.CHANNEL_PORT ?? RECEIVER.channelPort),
    token: env.CHANNEL_TOKEN,
    logger,
    queueSize: LIMITS.webhookQueue,
  });
  const device = normalizeIp(env.DEVICE_ADDRESS ?? '') ?? '';
  const idleMs = Number(env.IDLE_MS ?? LIMITS.receiverIdleMs);
  let window = [];
  /** source address -> times of its posts in the last minute (bounded map) */
  const bySource = new Map();
  /** The open connections, oldest first; `requested` once their headers arrived. */
  const conns = new Set();
  let lastRefusedNotice = -Infinity;
  const http = createServer(
    {
      connectionsCheckingInterval: 1000,
      headersTimeout: 5000,
      requestTimeout: 10_000,
      keepAliveTimeout: 1000,
      maxHeaderSize: 8192,
    },
    (request, response) => {
      const from = normalizeIp(request.socket.remoteAddress ?? '') ?? '';
      if (!isHookPath(request.url, token)) {
        request.resume();
        reply(response, 404, 'Not found');
        return;
      }
      if (request.method !== 'POST') {
        request.resume();
        reply(response, 405, 'Method not allowed');
        return;
      }
      // Budgets on the monotonic clock; the wall clock only dates the webhook.
      const time = monotonic();
      const wall = now();
      if (device && from !== device) {
        request.resume();
        reply(response, 403, 'Forbidden');
        if (time - lastRefusedNotice >= 10_000) {
          lastRefusedNotice = time;
          channel.send(
            { type: 'refused', from, at: new Date(wall).toISOString() },
            { queue: false },
          );
        }
        return;
      }
      const timestamp = String(request.headers.timestamp ?? '');
      const hash = String(request.headers.hash ?? '');
      if (!TIMESTAMP.test(timestamp) || !HASH.test(hash)) {
        request.resume();
        reply(response, 400, 'Bad request');
        return;
      }
      window = window.filter((t) => time - t < 60_000);
      const mine = (bySource.get(from) ?? []).filter((t) => time - t < 60_000);
      const limit = device && from === device ? LIMITS.webhooksPerMinute : LIMITS.webhooksPerSource;
      if (window.length >= LIMITS.webhooksPerMinute || mine.length >= limit) {
        request.resume();
        reply(response, 429, 'Too many requests');
        return;
      }
      window.push(time);
      mine.push(time);
      if (!bySource.has(from) && bySource.size >= 256) {
        bySource.clear();
      }
      bySource.set(from, mine);
      const declared = request.headers['content-length'];
      if (
        declared !== undefined &&
        (!/^\d{1,9}$/.test(declared) || Number(declared) > LIMITS.webhookBytes)
      ) {
        request.resume();
        reply(response, 413, 'Too large');
        return;
      }
      const parts = [];
      let size = 0;
      let refused = false;
      request.on('data', (chunk) => {
        if (refused) return;
        size += chunk.length;
        if (size > LIMITS.webhookBytes) {
          refused = true;
          reply(response, 413, 'Too large');
          request.destroy();
          return;
        }
        parts.push(chunk);
      });
      request.on('end', () => {
        if (refused) return;
        channel.send({
          type: 'webhook',
          from,
          at: new Date(wall).toISOString(),
          timestamp,
          hash: hash.toLowerCase(),
          // The exact bytes: the signature covers them.
          body: Buffer.concat(parts, size).toString('base64'),
        });
        reply(response, 200, 'OK');
      });
      request.on('error', () => {});
    },
  );

  const isDevice = (socket) => device !== '' && socket.lqFrom === device;
  /**
   * Closes the oldest connection whose request is not complete, among `which`:
   * first one that has sent no byte at all, only then one with partial headers.
   */
  const evictOldestSilent = (which) => {
    for (const pass of [(socket) => socket.bytesRead === 0, () => true]) {
      for (const socket of conns) {
        if (!socket.lqRequested && which(socket) && pass(socket)) {
          conns.delete(socket);
          socket.destroy();
          return true;
        }
      }
    }
    return false;
  };
  const count = (which) => {
    let n = 0;
    for (const socket of conns) if (which(socket)) n += 1;
    return n;
  };

  http.maxHeadersCount = 50;
  http.on('request', (request) => {
    request.socket.lqRequested = true;
  });
  http.on('connection', (socket) => {
    // Idle from its acceptance: a connection that sends nothing is closed.
    const idle = setTimeout(() => socket.destroy(), idleMs);
    idle.unref?.();
    socket.once('close', () => {
      clearTimeout(idle);
      conns.delete(socket);
    });
    socket.lqFrom = normalizeIp(socket.remoteAddress ?? '') ?? '';
    if (isDevice(socket)) {
      if (count(isDevice) >= LIMITS.receiverConnectionsPerSource) {
        evictOldestSilent(isDevice);
      }
    } else {
      const same = (s) => s.lqFrom === socket.lqFrom;
      const others = (s) => !isDevice(s);
      const limit = device
        ? LIMITS.receiverConnections - LIMITS.receiverConnectionsPerSource
        : LIMITS.receiverConnections;
      if (
        (count(same) >= LIMITS.receiverConnectionsPerSource && !evictOldestSilent(same)) ||
        (count(others) >= limit && !evictOldestSilent(others))
      ) {
        socket.destroy();
        return;
      }
    }
    conns.add(socket);
  });
  await channel.start();
  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(Number(env.HTTP_PORT ?? RECEIVER.httpPort), env.HTTP_HOST ?? '0.0.0.0', () => {
      http.off('error', reject);
      resolve();
    });
  });
  const port = http.address().port;
  logger?.info(`Webhook receiver on HTTP port ${port}; channel on port ${channel.port}`);
  return {
    http,
    channel,
    port,
    async stop() {
      await new Promise((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
      await channel.stop();
    },
  };
}
