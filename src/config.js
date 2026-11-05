// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The two keys of
// the bridge are kept here, decoded, and in the requests only: never logged,
// never in /data, never in a status or an error.
//
// Two values live in the Gladys configuration outside the `config_schema`
// (`webhook_token`, `channel_token`): the secrets the integration generates
// for its receiver, written with setConfig, never shown in the interface.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { decodeKey } from './loqed.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  key_id: 1,
  allow_unlock: false,
  allow_open: false,
  callback_address: '',
  check_webhook_source: true,
  poll_interval: 30,
  language: 'fr',
};

export const POLL = { min: 10, max: 600 };

/** The keys the integration writes itself (setConfig), outside the config_schema. */
export const TOKEN_KEYS = { webhook: 'webhook_token', channel: 'channel_token' };

const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
export const isToken = (value) => typeof value === 'string' && TOKEN.test(value);

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';
/** Only `false` (or the text "false") turns off: a missing value keeps the safe default. */
const strictFalse = (value) => value === false || value === 'false';

/** "::ffff:192.168.1.5" -> "192.168.1.5"; an IPv6 in lower case; undefined if not an IP. */
export function normalizeIp(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  let text = value.trim();
  if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(text)) {
    text = text.slice(7);
  }
  const version = isIP(text);
  if (version === 4) {
    return text;
  }
  return version === 6 ? text.toLowerCase() : undefined;
}

/** Addresses no bridge and no Gladys can have: any, broadcast, multicast. */
function forbiddenIp(ip) {
  if (ip.includes(':')) {
    return ip === '::' || /^ff/i.test(ip);
  }
  const [a] = ip.split('.').map(Number);
  return ip === '0.0.0.0' || ip === '255.255.255.255' || a === 0 || (a >= 224 && a <= 255);
}

/**
 * An IP address with an optional port ("192.168.1.50", "192.168.1.50:8080",
 * "[fd00::5]:80"); a name is refused (the webhooks are checked against the
 * source address, and a container resolves no `.local` name).
 * @returns {{ host: string, port: number } | { error: 'empty' | 'invalid' }}
 */
export function parseAddress(raw, defaultPort = 80) {
  const text =
    typeof raw === 'string'
      ? raw
          .trim()
          .replace(/^http:\/\//i, '')
          .replace(/\/$/, '')
      : '';
  if (text === '') {
    return { error: 'empty' };
  }
  // eslint-disable-next-line no-control-regex
  if (text.length > 64 || /[\s/@?#\\\u0000-\u001f\u007f]/.test(text)) {
    return { error: 'invalid' };
  }
  let host = text;
  let port = defaultPort;
  const bracketed = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(text);
  const withPort = /^([0-9.]+):(\d{1,5})$/.exec(text);
  if (bracketed) {
    host = bracketed[1];
    port = bracketed[2] === undefined ? defaultPort : Number(bracketed[2]);
  } else if (withPort) {
    host = withPort[1];
    port = Number(withPort[2]);
  }
  const ip = normalizeIp(host);
  if (!ip || forbiddenIp(ip) || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: 'invalid' };
  }
  return { host: ip, port };
}

/** The key id: an integer 0..255, from a number or a decimal text. */
function keyIdOf(value) {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^\d{1,3}$/.test(text)) {
    return undefined;
  }
  const n = Number(text);
  return n <= 255 ? n : undefined;
}

function pollOf(value) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim() || NaN);
  if (!Number.isFinite(n)) {
    return DEFAULT_CONFIG.poll_interval;
  }
  return Math.min(POLL.max, Math.max(POLL.min, Math.round(n)));
}

/** A short salted tag of the command key (8 bits), to notice a new key across restarts. */
export function keyTag(salt, config) {
  if (!config?.localKey || typeof salt !== 'string') {
    return null;
  }
  const digest = createHash('sha256')
    .update(salt)
    .update(Buffer.from([config.keyId ?? 0]))
    .update(config.localKey)
    .digest();
  return digest[0];
}

/**
 * The normalized configuration. `problem` names what keeps the module from
 * reading the bridge (missing or invalid address); `commandProblem` what keeps
 * it from sending commands (key id or local key); `hookProblem` what keeps it
 * from managing webhooks (bridge key, Gladys address).
 */
export function normalizeConfig(raw = {}) {
  const value = (key) => (raw && Object.hasOwn(raw, key) ? raw[key] : DEFAULT_CONFIG[key]);
  const address = parseAddress(value('bridge_address'));
  const keyId = keyIdOf(value('key_id'));
  const localKey = decodeKey(value('local_key'));
  const bridgeKey = decodeKey(value('bridge_key'));
  const callbackText = String(value('callback_address') ?? '').trim();
  const callback = callbackText === '' ? { error: 'empty' } : parseAddress(callbackText);
  const language = value('language') === 'en' ? 'en' : 'fr';
  let problem;
  if (address.error) {
    problem = address.error === 'empty' ? 'noAddress' : 'badAddress';
  }
  let commandProblem;
  if (keyId === undefined) {
    commandProblem = 'badKeyId';
  } else if (!localKey) {
    commandProblem = String(value('local_key') ?? '').trim() === '' ? 'noLocalKey' : 'badLocalKey';
  }
  let hookProblem;
  if (!bridgeKey) {
    hookProblem = String(value('bridge_key') ?? '').trim() === '' ? 'noBridgeKey' : 'badBridgeKey';
  } else if (callback.error) {
    hookProblem = callback.error === 'empty' ? 'noCallback' : 'badCallback';
  }
  return {
    host: address.host,
    port: address.port,
    keyId,
    localKey,
    bridgeKey,
    callbackHost: callback.host,
    // Unlocking and opening: only an explicit true allows.
    allowUnlock: strictTrue(value('allow_unlock')),
    allowOpen: strictTrue(value('allow_open')),
    // The sender check: on unless explicitly off.
    checkSource: !strictFalse(value('check_webhook_source')),
    pollInterval: pollOf(value('poll_interval')),
    language,
    problem,
    commandProblem,
    hookProblem,
  };
}

/** What, changed, restarts the module (the bridge it talks to). */
export const connectionKey = (config) => `${config.host ?? ''}|${config.port ?? ''}`;
