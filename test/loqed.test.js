// -----------------------------------------------------------------------------
// The protocol against vectors computed with the code of loqedAPI 2.1.18
// (Lock.getcommand, getWebhooks, registerWebhook, deleteWebhook,
// receiveWebhook), and the parsers against the fixtures of Home Assistant.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addHookHeaders,
  decodeKey,
  deleteHookHeaders,
  hookBody,
  listHooksHeaders,
  normalizeMac,
  parseEvent,
  parseStatus,
  positionOf,
  signCommand,
  strictInt,
  verifyWebhook,
} from '../src/loqed.js';

const SECRET = decodeKey('SGFsbG8gd2VyZWxkSGFsbG8gd2VyZWxkMTIzNDU2Nzg=');
const BRIDGE = decodeKey('Ym9uam91ciBtb25kZQ==');

test('commands: byte for byte what loqedAPI signs', () => {
  assert.equal(
    signCommand(1, 1, SECRET, 1700000000),
    'AAAAAAAAAAACBwAAAABlU/EAxSzg%2BPHRSBWvSf1umIUmrfEXFXRkfqeYMxPfn4zzYE8BAQE%3D',
  );
  assert.equal(
    signCommand(2, 1, SECRET, 1700000000),
    'AAAAAAAAAAACBwAAAABlU/EA7S5hilkfbMZAeebBYhO2Wp4XTuM0xXnRggwln/WYHjQBAQI%3D',
  );
  assert.equal(
    signCommand(3, 1, SECRET, 1700000000.9),
    'AAAAAAAAAAACBwAAAABlU/EAoLLiwf1n1nHfXSOOZ3P5H%2BTxwYzG%2BLEz6JnLQCsFOiwBAQM%3D',
  );
  assert.equal(
    signCommand(3, 255, SECRET, 1753000123),
    'AAAAAAAAAAACBwAAAABofKi7zO7u0M5wHwuo//UcY2pGqZzCXZiw3%2BjF/kciZFwvhdr/AQM%3D',
  );
  assert.throws(() => signCommand(4, 1, SECRET, 1));
  assert.throws(() => signCommand(3, 256, SECRET, 1));
  assert.throws(() => signCommand(3, 1, 'text', 1));
});

test('webhook management headers: what loqedAPI sends', () => {
  assert.deepEqual(listHooksHeaders(BRIDGE, 1700000000), {
    TIMESTAMP: '1700000000',
    HASH: '16b91b7f340c0cd4e72cf5d2405d530b4a7ca7ddc414cfee98887b9518e0598c',
  });
  assert.equal(
    addHookHeaders(BRIDGE, 1700000000, 'http://192.168.1.10:41234/loqed/abc', 511).HASH,
    'f7c3396afb9638dec819632192d9c2d40779b108901484dbf680eec1b3360b4d',
  );
  assert.equal(
    deleteHookHeaders(BRIDGE, 1700000000, 3).HASH,
    'c53a24cb3fde8e2393d05b8123ad7f9cd87c187c581b454b8c6b2c2075834849',
  );
  const body = JSON.parse(hookBody('http://x/y', 511));
  assert.equal(body.url, 'http://x/y');
  assert.equal(Object.keys(body).length, 10);
  assert.ok(
    Object.values(body)
      .slice(1)
      .every((v) => v === 1),
  );
});

test('webhook signature: the hash of loqedAPI receiveWebhook, checked strictly', () => {
  const body = Buffer.from(
    '{"go_to_state":"NIGHT_LOCK","event_type":"GO_TO_STATE_MANUAL_LOCK_BLE_NIGHT_LOCK","key_local_id":1}',
  );
  const hash = '8f6a53d17879b1e043310ebc33360b91f7b8c619923108fbe54d0844abcdbffb';
  assert.deepEqual(verifyWebhook({ body, timestamp: '1700000000', hash }, BRIDGE), {
    ok: true,
    seconds: 1700000000,
  });
  assert.equal(
    verifyWebhook({ body, timestamp: '1700000000', hash: hash.toUpperCase() }, BRIDGE).ok,
    true,
  );
  assert.equal(verifyWebhook({ body, timestamp: '1700000001', hash }, BRIDGE).ok, false);
  assert.equal(
    verifyWebhook({ body: Buffer.from(`${body} `), timestamp: '1700000000', hash }, BRIDGE).ok,
    false,
  );
  assert.equal(verifyWebhook({ body, timestamp: '1700000000', hash }, decodeKey('AAAA')).ok, false);
  assert.equal(verifyWebhook({ body, timestamp: '-1', hash }, BRIDGE).reason, 'timestamp');
  assert.equal(verifyWebhook({ body, timestamp: '1700000000', hash: 'zz' }, BRIDGE).reason, 'hash');
  assert.equal(verifyWebhook({ body, timestamp: '1700000000' }, BRIDGE).reason, 'hash');
  assert.equal(verifyWebhook({ body: 'text', timestamp: '1', hash }, BRIDGE).reason, 'missing');
});

test('keys: standard base64 of 1 to 64 bytes only', () => {
  assert.equal(decodeKey('Ym9uam91ciBtb25kZQ==').toString(), 'bonjour monde');
  for (const bad of [
    '',
    'abc',
    'Ym9u am91',
    'Ym9u\nam91',
    'Ym9uam91ciBtb25kZQ=',
    '****',
    42,
    null,
  ]) {
    assert.equal(decodeKey(bad), undefined, String(bad));
  }
  assert.equal(decodeKey('A'.repeat(100)), undefined);
});

test('status: the Home Assistant fixture, strict values, the lock away', () => {
  const fixture = {
    battery_percentage: 78,
    battery_type: 'NICKEL_METAL_HYDRIDE',
    bolt_state: 'day_lock',
    bridge_mac_wifi: 'aabbccddeeff',
    lock_online: 1,
    ble_strength: 20,
  };
  assert.deepEqual(parseStatus(fixture), {
    mac: 'aabbccddeeff',
    position: 'unlocked',
    battery: 78,
    online: true,
  });
  assert.equal(parseStatus({ ...fixture, bolt_state: 'night_lock' }).position, 'locked');
  assert.equal(parseStatus({ ...fixture, bolt_state: 'night_lock_remote' }).position, 'locked');
  assert.equal(parseStatus({ ...fixture, bolt_state: 'open' }).position, 'open');
  assert.equal(parseStatus({ ...fixture, bolt_state: 'motor_stall' }).position, 'jammed');
  assert.equal(parseStatus({ ...fixture, bolt_state: 'unknown' }).position, undefined);
  // Away from the bridge: no battery (the bridge says -1), offline.
  const away = parseStatus({ ...fixture, lock_online: 0, battery_percentage: 50 });
  assert.equal(away.online, false);
  assert.equal(away.battery, undefined);
  assert.equal(parseStatus({ ...fixture, lock_online: undefined, ble_strength: -1 }).online, false);
  // '' and null are unknown, never 0.
  assert.equal(parseStatus({ ...fixture, battery_percentage: '' }).battery, undefined);
  assert.equal(parseStatus({ ...fixture, battery_percentage: null }).battery, undefined);
  assert.equal(parseStatus({ ...fixture, battery_percentage: 12.5 }).battery, undefined);
  assert.equal(parseStatus({ ...fixture, battery_percentage: 101 }).battery, undefined);
  assert.equal(parseStatus({ ...fixture, bridge_mac_wifi: '**REDACTED**' }), undefined);
  assert.equal(parseStatus({ ...fixture, bridge_mac_wifi: '000000000000' }), undefined);
  assert.equal(parseStatus([fixture]), undefined);
  assert.equal(
    parseStatus(JSON.parse('{"__proto__": {"bridge_mac_wifi": "aabbccddeeff"}}')),
    undefined,
  );
});

test('events: the webhook bodies of loqedAPI and Home Assistant', () => {
  assert.deepEqual(parseEvent({ battery_type: 'NICKEL_METAL_HYDRIDE', battery_percentage: 88 }), {
    kind: 'battery',
    battery: 88,
    mac: undefined,
  });
  assert.equal(parseEvent({ battery_percentage: -1 }).battery, undefined);
  assert.deepEqual(
    parseEvent({ ble_strength: -1, wifi_strength: 70, mac_wifi: 'AA:BB:CC:DD:EE:FF' }),
    {
      kind: 'online',
      online: false,
      mac: 'aabbccddeeff',
    },
  );
  assert.deepEqual(parseEvent({ event_type: 'STATE_CHANGED_NIGHT_LOCK', key_local_id: 255 }), {
    kind: 'state',
    position: 'locked',
    keyId: 255,
    mac: undefined,
  });
  assert.equal(parseEvent({ event_type: 'state_changed_latch' }).position, 'unlocked');
  assert.equal(parseEvent({ event_type: 'STATE_CHANGED_OPEN' }).position, 'open');
  assert.equal(parseEvent({ event_type: 'STATE_CHANGED_UNKNOWN' }).kind, 'unclear');
  assert.deepEqual(
    parseEvent({ event_type: 'GO_TO_STATE_MANUAL_UNLOCK_BLE_OPEN', key_local_id: 3 }),
    {
      kind: 'moving',
      target: 'open',
      keyId: 3,
      mac: undefined,
    },
  );
  // The fixture "nightlock_reached": requested NIGHT_LOCK, event LATCH: unclear.
  assert.equal(
    parseEvent({
      requested_state: 'NIGHT_LOCK',
      event_type: 'STATE_CHANGED_LATCH',
      key_local_id: 255,
    }).kind,
    'unclear',
  );
  assert.equal(parseEvent({ event_type: 'SOMETHING_ELSE' }), undefined);
  assert.equal(parseEvent({ event_type: 'STATE_CHANGED_DANCING' }), undefined);
  assert.equal(parseEvent('text'), undefined);
});

test('helpers: MAC addresses, strict integers, positions', () => {
  assert.equal(normalizeMac('AA-BB-CC-DD-EE-FF'), 'aabbccddeeff');
  assert.equal(normalizeMac('aabbccddeef'), undefined);
  assert.equal(normalizeMac('ffffffffffff'), undefined);
  assert.equal(strictInt(''), undefined);
  assert.equal(strictInt(null), undefined);
  assert.equal(strictInt('12'), 12);
  assert.equal(strictInt('1.5'), undefined);
  assert.equal(strictInt(1.5), undefined);
  assert.equal(positionOf(3), undefined);
});
