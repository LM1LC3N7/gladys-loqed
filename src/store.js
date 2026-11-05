// -----------------------------------------------------------------------------
// What must survive a restart, in /data/loqed.json (the only writable place
// of the container), readable by the container user only (0600):
//
//   mac          the MAC address (Wi-Fi) of the bridge first read at the
//                configured address: it keys the external ids; another MAC at
//                that address is refused until "Use the bridge now answering"
//   otherMac     what answered instead, for that action (two clicks)
//   pendingLock  { at, sends } a lock clicked and not yet confirmed: `at`
//                the click (wall clock), `sends` the sends the bridge
//                answered 2xx. Sent again after a restart, before any read;
//                never given up because of its age
//   sensitive    { action, at } an unlock or an open about to leave (the
//                guard written before its first byte)
//   keyRefused   { tag, salt } the bridge refused the local key (401/403):
//                no automatic send; `tag` is 8 bits of a salted hash of the
//                REFUSED key only, to notice a new key saved while stopped
//   hooks        8 hex characters of the hash of each webhook URL this
//                module registered at the bridge (the URL holds a secret:
//                only its hash is kept), to withdraw the old ones
//   pausedUntil  the end of a pause asked by the bridge (429 / 5xx)
//   lastTry      the time of the last read (never faster than the interval,
//                even across restarts)
//
// Never a key, never a token. Read back bounded, only known keys of the
// expected shape (never an inherited or `__proto__` key).
//
// Every load and save is bounded in time (TIMINGS.storeTimeout): a /data that
// hangs (a network volume, a FIFO planted in place of the file) never holds a
// command. A file that is not a regular file is refused (opened O_NONBLOCK and
// O_NOFOLLOW, then fstat). Saves are coalesced: while one is written, only the
// latest data waits, so a hung write never piles them up.
// -----------------------------------------------------------------------------

import { constants } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { LIMITS, TIMINGS } from './constants.js';
import { normalizeMac } from './loqed.js';

export const STATE_FILE = '/data/loqed.json';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

/** Rejects after `ms` (the operation itself keeps going in the background). */
export function bounded(promise, ms, timers = globalThis) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = timers.setTimeout(
        () => reject(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' })),
        ms,
      );
    }),
  ]).finally(() => timers.clearTimeout(timer));
}

const FLAGS_READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const FLAGS_WRITE =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_TRUNC |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;

async function readRegular(path) {
  let handle;
  try {
    handle = await open(path, FLAGS_READ);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw Object.assign(new Error('Not a regular file'), { code: 'EFTYPE' });
    }
    if (stat.size > LIMITS.memoryBytes) {
      throw Object.assign(new Error('Too large'), { code: 'ETOOBIG' });
    }
    const buffer = Buffer.alloc(LIMITS.memoryBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > LIMITS.memoryBytes) {
      throw Object.assign(new Error('Too large'), { code: 'ETOOBIG' });
    }
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await handle.close().catch(() => {});
  }
}

async function writeRegular(path, text) {
  const temporary = `${path}.tmp`;
  const handle = await open(temporary, FLAGS_WRITE, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw Object.assign(new Error('Not a regular file'), { code: 'EFTYPE' });
    }
    await handle.writeFile(text, 'utf8');
  } finally {
    await handle.close().catch(() => {});
  }
  await rename(temporary, path);
}

/**
 * The /data store: `load()` (null when there is no file; throws when it
 * exists but cannot be read) and `save(data)` (resolves once THIS data, or a
 * later one, is on disk; rejects on failure). Both bounded in time.
 */
export function fileStore(path = STATE_FILE, { timers = globalThis } = {}) {
  let writing;
  let waiting;
  const run = () => {
    const job = waiting;
    waiting = undefined;
    writing = writeRegular(path, job.text).then(
      () => job.resolvers.forEach(([resolve]) => resolve()),
      (err) => job.resolvers.forEach(([, reject]) => reject(err)),
    );
    writing.finally(() => {
      writing = undefined;
      if (waiting) run();
    });
  };
  return {
    load() {
      return bounded(readRegular(path), TIMINGS.storeTimeout, timers);
    },
    save(data) {
      const text = JSON.stringify(data);
      const done = new Promise((resolve, reject) => {
        if (waiting) {
          waiting.text = text;
          waiting.resolvers.push([resolve, reject]);
        } else {
          waiting = { text, resolvers: [[resolve, reject]] };
        }
      });
      if (!writing) run();
      return bounded(done, TIMINGS.storeTimeout, timers);
    },
  };
}

/**
 * For the tests: the same JSON round trip as the file. `failing` refuses
 * every save, `unreadable` every load, `hang` never settles (a stuck /data).
 */
export function memoryStore(initial = null, { failing = false, unreadable = false } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    failing,
    unreadable,
    hang: false,
    async load() {
      if (this.hang) return new Promise(() => {});
      if (this.unreadable) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      if (this.hang) return new Promise(() => {});
      if (this.failing) {
        throw new Error('EROFS');
      }
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

export const emptyMemory = () => ({
  mac: null,
  otherMac: null,
  pendingLock: null,
  sensitive: null,
  keyRefused: null,
  hooks: [],
  pausedUntil: 0,
  lastTry: 0,
});

/** A wall time from /data: a positive number, never after `now` (a future date is invalid). */
const wallTime = (value, now) =>
  Number.isFinite(value) && value > 0 && value <= now ? value : undefined;

/** The persisted state, repaired and bounded against `now` (wall clock). */
export function normalizeMemory(raw, now) {
  const memory = emptyMemory();
  memory.mac = normalizeMac(own(raw, 'mac')) ?? null;
  memory.otherMac = memory.mac ? (normalizeMac(own(raw, 'otherMac')) ?? null) : null;
  if (memory.otherMac === memory.mac) memory.otherMac = null;
  const pending = own(raw, 'pendingLock');
  if (isObject(pending) || pending === true) {
    // A lock waiting is never dropped because its record is odd: an unreadable
    // count is 0, an unreadable or future click time is "now".
    const sends = own(pending, 'sends');
    memory.pendingLock = {
      at: wallTime(own(pending, 'at'), now) ?? now,
      sends: Number.isInteger(sends) && sends >= 0 && sends <= LIMITS.lockSends ? sends : 0,
    };
  }
  const sensitive = own(raw, 'sensitive');
  const action = own(sensitive, 'action');
  const at = wallTime(own(sensitive, 'at'), now);
  if ((action === 'unlock' || action === 'open') && at !== undefined) {
    memory.sensitive = { action, at };
  }
  const refused = own(raw, 'keyRefused');
  if (isObject(refused)) {
    const tag = own(refused, 'tag');
    const salt = own(refused, 'salt');
    memory.keyRefused = {
      tag: Number.isInteger(tag) && tag >= 0 && tag < 256 ? tag : null,
      salt: typeof salt === 'string' && /^[0-9a-f]{32}$/.test(salt) ? salt : null,
    };
  }
  const hooks = own(raw, 'hooks');
  if (Array.isArray(hooks)) {
    memory.hooks = hooks.filter((h) => typeof h === 'string' && /^[0-9a-f]{8}$/.test(h)).slice(-8);
  }
  // A pause dated beyond its longest length is invalid.
  const paused = own(raw, 'pausedUntil');
  memory.pausedUntil =
    Number.isFinite(paused) && paused > now && paused <= now + TIMINGS.pauseMax ? paused : 0;
  memory.lastTry = wallTime(own(raw, 'lastTry'), now) ?? 0;
  return memory;
}

export const serializeMemory = (memory) => ({
  mac: memory.mac,
  otherMac: memory.otherMac,
  pendingLock: memory.pendingLock,
  sensitive: memory.sensitive,
  keyRefused: memory.keyRefused,
  hooks: memory.hooks,
  pausedUntil: memory.pausedUntil,
  lastTry: memory.lastTry,
});
