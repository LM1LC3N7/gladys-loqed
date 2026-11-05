// -----------------------------------------------------------------------------
// /data: the file store on a real temporary directory (removed after), never
// waiting without bound (a FIFO in place of the file, a symbolic link), only
// known keys read back, future dates refused, a waiting lock never dropped;
// the configuration parser.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStore, normalizeMemory } from '../src/store.js';
import { normalizeConfig, parseAddress } from '../src/config.js';
import { within } from './helpers/clock.js';

async function dir(t) {
  const path = await mkdtemp(join(tmpdir(), 'loqed-store-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('file store: round trip, 0600, null when absent', async (t) => {
  const path = join(await dir(t), 'loqed.json');
  const store = fileStore(path);
  assert.equal(await store.load(), null);
  await store.save({ mac: 'aabbccddeeff' });
  assert.deepEqual(await store.load(), { mac: 'aabbccddeeff' });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('file store: saves coalesced, the latest wins', async (t) => {
  const path = join(await dir(t), 'loqed.json');
  const store = fileStore(path);
  await Promise.all([1, 2, 3, 4].map((n) => store.save({ n })));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { n: 4 });
});

test('file store: a FIFO or a link in place of the file is refused at once, never awaited', async (t) => {
  // Its own directory, removed only once a blocked open of a FIFO (whatever
  // the code does) has been woken: one hook, in that order.
  const base = await mkdtemp(join(tmpdir(), 'loqed-fifo-'));
  const fifo = join(base, 'loqed.json');
  const fifoTmp = join(base, 'other.json.tmp');
  t.after(async () => {
    for (const path of [fifo, fifoTmp]) {
      const handle = await open(path, constants.O_RDWR | constants.O_NONBLOCK).catch(() => null);
      // Held a moment so a blocked open on the other side completes, then EOF.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await handle?.close();
    }
    await rm(base, { recursive: true, force: true });
  });
  execFileSync('mkfifo', [fifo]);
  execFileSync('mkfifo', [fifoTmp]);
  let started = performance.now();
  await assert.rejects(
    within(fileStore(fifo).load(), 2500, 'load'),
    (err) => err.code === 'EFTYPE',
  );
  assert.ok(performance.now() - started < 500, 'at once, not by the time bound');
  started = performance.now();
  await assert.rejects(
    within(fileStore(join(base, 'other.json')).save({ a: 1 }), 2500, 'save'),
    (err) => err.code === 'ENXIO' || err.code === 'EFTYPE',
  );
  assert.ok(performance.now() - started < 500, 'at once, not by the time bound');
  const target = join(base, 'target.json');
  await writeFile(target, '{"mac":"aabbccddeeff"}');
  const link = join(base, 'link.json');
  await symlink(target, link);
  await assert.rejects(fileStore(link).load(), /ELOOP|EMLINK|./);
});

test('file store: too large or not JSON is unreadable (never empty)', async (t) => {
  const base = await dir(t);
  await writeFile(join(base, 'big.json'), `"${'x'.repeat(9000)}"`);
  await assert.rejects(fileStore(join(base, 'big.json')).load(), /Too large/);
  await writeFile(join(base, 'bad.json'), '{');
  await assert.rejects(fileStore(join(base, 'bad.json')).load());
});

test('memory: known keys only, bounded; future dates invalid but a waiting lock is never dropped', () => {
  const now = Date.UTC(2026, 10, 5, 12);
  const m = normalizeMemory(
    {
      mac: 'AA:BB:CC:DD:EE:FF',
      otherMac: 'aabbccddeeff',
      pendingLock: { at: now + 3_600_000, sends: 9 },
      sensitive: { action: 'open', at: now + 1 },
      keyRefused: { tag: 300, salt: 'x' },
      hooks: ['0123abcd', 'nope', 5],
      pausedUntil: now + 7 * 3_600_000,
      lastTry: now + 10,
      extra: 1,
    },
    now,
  );
  assert.equal(m.mac, 'aabbccddeeff');
  assert.equal(m.otherMac, null);
  assert.deepEqual(m.pendingLock, { at: now, sends: 0 });
  assert.equal(m.sensitive, null);
  assert.deepEqual(m.keyRefused, { tag: null, salt: null });
  assert.deepEqual(m.hooks, ['0123abcd']);
  assert.equal(m.pausedUntil, 0);
  assert.equal(m.lastTry, 0);
  assert.equal('extra' in m, false);
  assert.deepEqual(normalizeMemory({ pendingLock: true }, now).pendingLock, { at: now, sends: 0 });
  assert.equal(normalizeMemory(JSON.parse('{"__proto__":{"mac":"aabbccddeeff"}}'), now).mac, null);
  assert.equal(normalizeMemory(null, now).pendingLock, null);
});

test('config: addresses (IP only, never broadcast nor multicast), keys, options strictly true', () => {
  assert.deepEqual(parseAddress('192.168.1.50'), { host: '192.168.1.50', port: 80 });
  assert.deepEqual(parseAddress('http://192.168.1.50:8080/'), { host: '192.168.1.50', port: 8080 });
  assert.deepEqual(parseAddress('[FD00::5]:81'), { host: 'fd00::5', port: 81 });
  for (const bad of [
    'loqed.local',
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '192.168.1.50:0',
    '192.168.1.50:70000',
    '1.2.3.4/x',
    '1.2.\r\n3.4',
    'a@1.2.3.4',
  ]) {
    assert.ok(parseAddress(bad).error, bad);
  }
  const c = normalizeConfig({
    bridge_address: '192.168.1.50',
    key_id: '7',
    local_key: 'SGFsbG8=',
    bridge_key: 'Ym9uam91cg==',
    allow_unlock: 'yes',
    allow_open: 1,
    check_webhook_source: 'no',
    poll_interval: 1,
  });
  assert.equal(c.keyId, 7);
  assert.equal(c.allowUnlock, false);
  assert.equal(c.allowOpen, false);
  assert.equal(c.checkSource, true, 'only an explicit false turns the check off');
  assert.equal(c.pollInterval, 10);
  assert.equal(c.hookProblem, 'noCallback');
  assert.equal(normalizeConfig({ key_id: 256 }).commandProblem, 'badKeyId');
  assert.equal(normalizeConfig({ key_id: '1.5' }).commandProblem, 'badKeyId');
  assert.equal(
    normalizeConfig({ key_id: 1, local_key: 'not base64!' }).commandProblem,
    'badLocalKey',
  );
  assert.equal(normalizeConfig({}).problem, 'noAddress');
  assert.equal(normalizeConfig({ allow_unlock: true }).allowUnlock, true);
});
