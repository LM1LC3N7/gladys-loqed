// -----------------------------------------------------------------------------
// A fake LOQED bridge on 127.0.0.1 (a free port), built from loqedAPI 2.1.18
// and the fixtures of Home Assistant's LOQED tests: GET /status, GET /to_lock
// (the command is decoded and its HMAC checked with the local key, as the
// bridge does), GET/POST/DELETE /webhooks (TIMESTAMP + HASH checked with the
// bridge key). Behaviours can be changed live:
//
//   statusMode   'ok' | 'silent' (never answers) | <number> (that HTTP status)
//   statusDelay  ms before /status answers
//   commandMode  'ok' | 'silent' | <number>
//   motorMs      ms before an accepted command changes the bolt
//   ignore       accepted commands do not move the bolt
//   down         every connection is closed at once
// -----------------------------------------------------------------------------

import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';

export const LOCAL_KEY = 'SGFsbG8gd2VyZWxkSGFsbG8gd2VyZWxkMTIzNDU2Nzg=';
export const BRIDGE_KEY = 'Ym9uam91ciBtb25kZQ==';
export const MAC = 'aabbccddeeff';
export const OTHER_MAC = '112233445566';

const ACTIONS = { 1: 'open', 2: 'unlock', 3: 'lock' };
const BOLT = { open: 'open', unlock: 'day_lock', lock: 'night_lock' };

const uint64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};

/** Decodes and checks a signed command; `{ action, keyId, seconds, valid }` or undefined. */
export function decodeCommand(param, key = LOCAL_KEY) {
  const bytes = Buffer.from(decodeURIComponent(param), 'base64');
  if (bytes.length !== 53) return undefined;
  const head = bytes.subarray(8, 10);
  const time = bytes.subarray(10, 18);
  const mac = bytes.subarray(18, 50);
  const tail = bytes.subarray(50, 53);
  const expected = createHmac('sha256', Buffer.from(key, 'base64'))
    .update(Buffer.concat([head, time, tail]))
    .digest();
  return {
    action: ACTIONS[tail[2]],
    keyId: tail[0],
    seconds: Number(time.readBigUInt64BE()),
    valid: expected.equals(mac) && head[0] === 2 && head[1] === 7 && tail[1] === 1,
  };
}

export async function fakeBridge(options = {}) {
  const bridge = {
    mac: MAC,
    bolt: 'day_lock',
    online: 1,
    battery: 78,
    statusMode: 'ok',
    statusDelay: 0,
    commandMode: 'ok',
    commandDelay: 0,
    motorMs: 0,
    ignore: false,
    down: false,
    localKey: LOCAL_KEY,
    bridgeKey: BRIDGE_KEY,
    hooks: [],
    nextHookId: 1,
    requests: [],
    commands: [],
    ...options,
  };
  const sockets = new Set();
  const status = () => ({
    battery_percentage: bridge.online ? bridge.battery : -1,
    battery_type: 'NICKEL_METAL_HYDRIDE',
    battery_type_numeric: 1,
    battery_voltage: 10.37,
    bolt_state: bridge.bolt,
    bolt_state_numeric: 2,
    bridge_mac_wifi: bridge.mac,
    bridge_mac_ble: 'aabbccddeeaa',
    lock_online: bridge.online,
    webhooks_number: bridge.hooks.length,
    ip_address: '127.0.0.1',
    up_timestamp: 1653041994,
    wifi_strength: 73,
    ble_strength: bridge.online ? 20 : -1,
  });
  const send = (res, code, body) => {
    if (res.destroyed) return;
    res.writeHead(code, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const hashOk = (req, fields) => {
    const ts = String(req.headers.timestamp ?? '');
    const expected = createHash('sha256')
      .update(
        Buffer.concat([...fields, uint64(Number(ts)), Buffer.from(bridge.bridgeKey, 'base64')]),
      )
      .digest('hex');
    return /^\d+$/.test(ts) && req.headers.hash === expected;
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://bridge');
      const body = Buffer.concat(chunks).toString('utf8');
      const entry = {
        method: req.method,
        path: url.pathname,
        at: performance.now(),
        headers: req.headers,
        body,
      };
      bridge.requests.push(entry);
      if (url.pathname === '/status' && req.method === 'GET') {
        if (bridge.statusMode === 'silent') return;
        const snapshot = status();
        setTimeout(() => {
          if (typeof bridge.statusMode === 'number') send(res, bridge.statusMode, 'error');
          else if (bridge.statusBody !== undefined) send(res, 200, bridge.statusBody);
          else send(res, 200, snapshot);
        }, bridge.statusDelay);
        return;
      }
      if (url.pathname === '/to_lock' && req.method === 'GET') {
        const param = /command_signed_base64=([^&]*)/.exec(req.url)?.[1] ?? '';
        const command = decodeCommand(param, bridge.localKey);
        entry.command = command;
        bridge.commands.push({ ...command, at: entry.at });
        if (bridge.commandMode === 'silent') return;
        setTimeout(() => {
          if (typeof bridge.commandMode === 'number') {
            send(res, bridge.commandMode, 'error');
            return;
          }
          if (!command?.valid) {
            send(res, 401, 'invalid hash');
            return;
          }
          if (!bridge.ignore && bridge.online) {
            // motorMs 0: the bolt is there before the answer leaves (no race
            // with a read that follows at once); otherwise it moves later.
            if (bridge.motorMs === 0) bridge.bolt = BOLT[command.action];
            else setTimeout(() => (bridge.bolt = BOLT[command.action]), bridge.motorMs);
          }
          send(res, 200, 'OK');
        }, bridge.commandDelay);
        return;
      }
      if (url.pathname === '/webhooks' && req.method === 'GET') {
        if (!hashOk(req, [])) return send(res, 401, 'bad hash');
        return send(res, 200, bridge.hooks);
      }
      if (url.pathname === '/webhooks' && req.method === 'POST') {
        let json;
        try {
          json = JSON.parse(body);
        } catch {
          return send(res, 400, 'bad json');
        }
        const flags = Buffer.alloc(4);
        flags.writeUInt32BE(511);
        if (!hashOk(req, [Buffer.from(json.url ?? ''), flags])) return send(res, 401, 'bad hash');
        bridge.hooks.push({ id: bridge.nextHookId, ...json });
        bridge.nextHookId += 1;
        return send(res, 200, 'CREATED');
      }
      const del = /^\/webhooks\/(\d+)$/.exec(url.pathname);
      if (del && req.method === 'DELETE') {
        if (!hashOk(req, [uint64(Number(del[1]))])) return send(res, 401, 'bad hash');
        bridge.hooks = bridge.hooks.filter((h) => h.id !== Number(del[1]));
        return send(res, 200, 'DELETED');
      }
      send(res, 404, 'not found');
    });
  });
  server.on('connection', (socket) => {
    bridge.connections = (bridge.connections ?? 0) + 1;
    if (bridge.down) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  bridge.port = server.address().port;
  bridge.address = `127.0.0.1:${bridge.port}`;
  bridge.count = (path) => bridge.requests.filter((r) => r.path === path).length;
  let listening = true;
  bridge.close = async () => {
    for (const socket of sockets) socket.destroy();
    if (listening) await new Promise((resolve) => server.close(resolve));
    listening = false;
  };
  /** Stops listening: connections are refused (nothing can be sent). */
  bridge.unplug = () => bridge.close();
  /** Listens again on the same port. */
  bridge.plug = async () => {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(bridge.port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    listening = true;
  };
  return bridge;
}

/** TIMESTAMP and HASH of a webhook body, as the bridge signs it. */
export function signWebhook(body, seconds, key = BRIDGE_KEY) {
  const hash = createHash('sha256')
    .update(Buffer.concat([Buffer.from(body, 'utf8'), uint64(seconds), Buffer.from(key, 'base64')]))
    .digest('hex');
  return { timestamp: String(seconds), hash };
}
