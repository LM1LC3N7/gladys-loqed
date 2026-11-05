// -----------------------------------------------------------------------------
// The LOQED bridge protocol, pure functions ported from loqedAPI 2.1.18
// (BSD-2-Clause, Casper Polhout, src/loqedAPI/loqed.py; see
// THIRD_PARTY_NOTICES.md):
//
// - a command is 53 bytes: message id (8 zero bytes), protocol 2, command
//   type 7, the time in seconds (8 bytes big endian), the HMAC-SHA256 of
//   (protocol, type, time, key id, device id 1, action) with the local key,
//   then key id, device id, action; base64, then URL-quoted as Python's
//   urllib.parse.quote does (only "/" kept);
// - the webhook management requests carry TIMESTAMP (seconds) and HASH, the
//   SHA-256 hex of (fields, time on 8 bytes, bridge key);
// - a webhook from the bridge carries TIMESTAMP and HASH = SHA-256 hex of
//   (body, time on 8 bytes, bridge key).
//
// Keys are only ever used here as Buffers: never logged, never put in an
// error message.
// -----------------------------------------------------------------------------

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ACTION_CODES, POSITIONS } from './constants.js';

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** A key as the LOQED app gives it (standard base64, 1 to 64 bytes) -> Buffer, else undefined. */
export function decodeKey(text) {
  if (typeof text !== 'string') {
    return undefined;
  }
  const trimmed = text.trim();
  if (trimmed.length < 4 || trimmed.length > 96 || !BASE64.test(trimmed)) {
    return undefined;
  }
  const bytes = Buffer.from(trimmed, 'base64');
  return bytes.length >= 1 && bytes.length <= 64 ? bytes : undefined;
}

const uint64 = (value) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
};

/** Python's urllib.parse.quote on base64 text: "+" and "=" escaped, "/" kept. */
const quote = (text) => text.replace(/\+/g, '%2B').replace(/=/g, '%3D');

/**
 * The `command_signed_base64` value of a command.
 * @param {number} action ACTION_CODES value
 * @param {number} keyId local key id, 0..255
 * @param {Buffer} key the local key (decoded)
 * @param {number} seconds Unix time in seconds (the bridge checks it)
 */
export function signCommand(action, keyId, key, seconds) {
  if (!Object.values(ACTION_CODES).includes(action)) {
    throw new Error('Unknown action');
  }
  if (!Number.isInteger(keyId) || keyId < 0 || keyId > 255 || !Buffer.isBuffer(key)) {
    throw new Error('Invalid key');
  }
  const head = Buffer.from([2, 7]);
  const time = uint64(Math.max(0, Math.floor(seconds)));
  const tail = Buffer.from([keyId, 1, action]);
  const mac = createHmac('sha256', key)
    .update(Buffer.concat([head, time, tail]))
    .digest();
  const command = Buffer.concat([Buffer.alloc(8), head, time, mac, tail]);
  return quote(command.toString('base64'));
}

/** TIMESTAMP and HASH headers of a webhook management request; `fields` are the Buffers hashed first. */
export function managementHeaders(bridgeKey, seconds, fields = []) {
  const time = Math.max(0, Math.floor(seconds));
  const hash = createHash('sha256')
    .update(Buffer.concat([...fields, uint64(time), bridgeKey]))
    .digest('hex');
  return { TIMESTAMP: String(time), HASH: hash };
}

export const listHooksHeaders = (bridgeKey, seconds) => managementHeaders(bridgeKey, seconds);

export function addHookHeaders(bridgeKey, seconds, url, flags) {
  const flagBytes = Buffer.alloc(4);
  flagBytes.writeUInt32BE(flags);
  return managementHeaders(bridgeKey, seconds, [Buffer.from(url, 'utf8'), flagBytes]);
}

export const deleteHookHeaders = (bridgeKey, seconds, id) =>
  managementHeaders(bridgeKey, seconds, [uint64(id)]);

/** The JSON body of a webhook registration (loqedAPI registerWebhook, every trigger on). */
export function hookBody(url, flags) {
  const names = [
    'trigger_state_changed_open',
    'trigger_state_changed_latch',
    'trigger_state_changed_night_lock',
    'trigger_state_changed_unknown',
    'trigger_state_goto_open',
    'trigger_state_goto_latch',
    'trigger_state_goto_night_lock',
    'trigger_battery',
    'trigger_online_status',
  ];
  const body = { url };
  names.forEach((name, bit) => {
    body[name] = (flags >> bit) & 1;
  });
  return JSON.stringify(body);
}

const HEX64 = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{1,12}$/;

/**
 * Checks the signature of a webhook (raw body bytes, TIMESTAMP and HASH
 * headers). Never throws.
 * @returns {{ ok: true, seconds: number } | { ok: false, reason: string }}
 */
export function verifyWebhook({ body, timestamp, hash }, bridgeKey) {
  if (!Buffer.isBuffer(body) || !Buffer.isBuffer(bridgeKey)) {
    return { ok: false, reason: 'missing' };
  }
  if (typeof timestamp !== 'string' || !TIMESTAMP.test(timestamp)) {
    return { ok: false, reason: 'timestamp' };
  }
  const received = typeof hash === 'string' ? hash.toLowerCase() : '';
  if (!HEX64.test(received)) {
    return { ok: false, reason: 'hash' };
  }
  const seconds = Number(timestamp);
  const expected = createHash('sha256')
    .update(Buffer.concat([body, uint64(seconds), bridgeKey]))
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(received, 'hex'))) {
    return { ok: false, reason: 'hash' };
  }
  return { ok: true, seconds };
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

/** A MAC address as the bridge writes it ("aabbccddeeff", with or without ":"), else undefined. */
export function normalizeMac(value) {
  if (typeof value !== 'string' || value.length > 17) {
    return undefined;
  }
  const text = value.trim().toLowerCase().replace(/[:-]/g, '');
  if (!/^[0-9a-f]{12}$/.test(text) || /^0{12}$|^f{12}$/.test(text)) {
    return undefined;
  }
  return text;
}

/** A strict integer from a number or a decimal text; '' and null are unknown, never 0. */
export function strictInt(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^-?\d{1,6}$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

/** The bolt state of /status ("night_lock", ...) -> a POSITIONS value, or undefined (unknown). */
export function positionOf(boltState) {
  if (typeof boltState !== 'string') {
    return undefined;
  }
  switch (boltState.trim().toLowerCase()) {
    case 'night_lock':
    case 'night_lock_remote':
      return POSITIONS.LOCKED;
    case 'day_lock':
    case 'latch':
      return POSITIONS.UNLOCKED;
    case 'open':
      return POSITIONS.OPEN;
    case 'motor_stall':
      return POSITIONS.JAMMED;
    default:
      return undefined;
  }
}

/** Battery percent: 0..100 only (the bridge says -1 while the lock is away). */
const battery = (value) => {
  const n = strictInt(value);
  return n !== undefined && n >= 0 && n <= 100 ? n : undefined;
};

/** The online flag: 1/0 or true/false; undefined when absent or odd. */
const flag = (value) => {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return undefined;
};

/**
 * The answer of GET /status -> { mac, position, battery, online, ip } or
 * undefined when it is not a status of a bridge (no MAC address).
 */
export function parseStatus(json) {
  if (!isObject(json)) {
    return undefined;
  }
  const mac = normalizeMac(own(json, 'bridge_mac_wifi'));
  if (!mac) {
    return undefined;
  }
  const online = flag(own(json, 'lock_online'));
  const ble = strictInt(own(json, 'ble_strength'));
  const lockOnline = online ?? (ble === undefined ? undefined : ble !== -1);
  return {
    mac,
    position: positionOf(own(json, 'bolt_state')),
    // A battery or a position read while the lock is away from the bridge is stale.
    battery: lockOnline === false ? undefined : battery(own(json, 'battery_percentage')),
    online: lockOnline,
  };
}

const EVENT = /^(STATE_CHANGED|GO_TO_STATE)_[A-Z0-9_]{0,80}$/;
const SUFFIXES = [
  ['NIGHT_LOCK', POSITIONS.LOCKED],
  ['LATCH', POSITIONS.UNLOCKED],
  ['OPEN', POSITIONS.OPEN],
  ['UNKNOWN', undefined],
];

/**
 * The JSON of a webhook (already verified) -> one event:
 *   { kind: 'state', position, keyId, mac }     the bolt reached a position
 *   { kind: 'moving', target, keyId, mac }      the bolt started moving
 *   { kind: 'battery', battery, mac }           (battery undefined: lock away)
 *   { kind: 'online', online, mac }
 *   undefined                                   anything else
 * A STATE_CHANGED whose `requested_state` names another position is ambiguous:
 * kind 'unclear' (only a read decides).
 */
export function parseEvent(json) {
  if (!isObject(json)) {
    return undefined;
  }
  const mac = normalizeMac(own(json, 'mac_wifi'));
  if (own(json, 'battery_percentage') !== undefined) {
    return { kind: 'battery', battery: battery(own(json, 'battery_percentage')), mac };
  }
  if (own(json, 'ble_strength') !== undefined || own(json, 'wifi_strength') !== undefined) {
    const ble = strictInt(own(json, 'ble_strength'));
    return { kind: 'online', online: ble === undefined ? undefined : ble !== -1, mac };
  }
  const type = own(json, 'event_type');
  if (typeof type !== 'string' || !EVENT.test(type.trim().toUpperCase())) {
    return undefined;
  }
  const event = type.trim().toUpperCase();
  const keyId = strictInt(own(json, 'key_local_id'));
  const suffix = SUFFIXES.find(([end]) => event.endsWith(`_${end}`));
  if (!suffix) {
    return undefined;
  }
  const position = suffix[1];
  if (event.startsWith('GO_TO_STATE')) {
    return { kind: 'moving', target: position, keyId, mac };
  }
  const requested = own(json, 'requested_state');
  if (typeof requested === 'string' && requested !== '') {
    const named = SUFFIXES.find(([end]) => requested.trim().toUpperCase() === end);
    if (!named || named[1] !== position) {
      return { kind: 'unclear', keyId, mac };
    }
  }
  if (position === undefined) {
    return { kind: 'unclear', keyId, mac };
  }
  return { kind: 'state', position, keyId, mac };
}
