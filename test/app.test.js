// -----------------------------------------------------------------------------
// The app end to end: fake Gladys, the handlers of the container, a fake
// bridge on 127.0.0.1 that checks the signatures, the virtual clock. Discovery,
// reads, the lock (never held back), unlocking and opening (off by default,
// guarded), the order of reads and commands.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAC, OTHER_MAC } from './helpers/bridge.js';
import { fid, last, press, settle, setup, waitFor, within } from './helpers/app.js';
import { BridgeError, ERROR_KINDS, bridgeRequest } from '../src/bridge.js';
import { TIMINGS } from '../src/constants.js';
import { memoryStore } from '../src/store.js';

const commands = (ctx, action) => ctx.bridge.commands.filter((c) => !action || c.action === action);

test('discovery: one device keyed on the MAC, buttons only, never a switch nor a binary', async (t) => {
  const ctx = await setup(t);
  const [device] = ctx.gladys.fake.discoveredDevices;
  assert.equal(device.external_id, `ext:loqed:bridge:${MAC}`);
  const byKey = Object.fromEntries(
    device.features.map((f) => [f.external_id.split(':').at(-1), f]),
  );
  assert.deepEqual(Object.keys(byKey), [
    'state',
    'position',
    'battery',
    'lock',
    'unlock',
    'open',
    'last_command',
  ]);
  for (const f of device.features) {
    assert.notEqual(f.category, 'switch');
    assert.ok(f.read_only || (f.category === 'button' && f.type === 'push'), f.external_id);
    assert.ok(!(f.type === 'binary' && !f.read_only), 'never a commandable binary');
    assert.equal(f.supported_options, undefined);
  }
  assert.equal(byKey.state.category, 'lock');
  assert.equal(byKey.state.type, 'state');
  assert.equal(last(ctx.gladys, 'state'), 0);
  assert.equal(last(ctx.gladys, 'battery'), 78);
  assert.equal(last(ctx.gladys, 'position'), 'Unlocked (day lock)');
  assert.equal(ctx.store.data.mac, MAC);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
});

test('lock: options off, signed with the local key, confirmed by a read started after it', async (t) => {
  const ctx = await setup(t);
  const ack = await press(ctx, 'lock');
  assert.equal(ack.success, true);
  const [command] = commands(ctx);
  assert.equal(command.action, 'lock');
  assert.equal(command.valid, true);
  assert.equal(command.keyId, 1);
  assert.ok(Math.abs(command.seconds - ctx.clock.now() / 1000) < 2);
  assert.deepEqual(ctx.store.data.pendingLock.sends, 1);
  await ctx.clock.advance(TIMINGS.followUps[0]);
  await waitFor(() => ctx.store.data.pendingLock === null, { what: 'confirmed' });
  assert.equal(last(ctx.gladys, 'state'), 1);
  assert.equal(last(ctx.gladys, 'last_command'), 'Locked (confirmed by the lock).');
});

test('lock: never waits for a read in flight (it is cancelled), nor a stuck /data, several in a row', async (t) => {
  const ctx = await setup(t);
  ctx.bridge.statusMode = 'silent';
  const reading = ctx.app.read();
  await waitFor(() => ctx.bridge.count('/status') >= 2, { what: 'read out' });
  ctx.store.hang = true;
  for (let i = 0; i < 3; i += 1) {
    const ack = await press(ctx, 'lock');
    assert.equal(ack.success, true, `lock ${i}`);
  }
  assert.equal(commands(ctx, 'lock').length, 3);
  await within(reading, 2000, 'the read in flight is cut by the lock');
  assert.equal(ctx.app.reads.size, 0, 'the read was cut');
  assert.equal(ctx.app.failures, 0, 'a read cut by a lock is not a failure');
});

test('lock: goes during a 429 pause, while the bridge was never identified, with the options off', async (t) => {
  const ctx = await setup(t, { start: false, bridge: { statusMode: 429 } });
  await ctx.gladys.connect();
  await ctx.clock.advance(0);
  await waitFor(() => ctx.app.failures > 0, { what: 'paused' });
  assert.ok(ctx.app.paused());
  assert.equal(ctx.app.memory.mac, null);
  const ack = await press(ctx, 'lock');
  assert.equal(ack.success, true);
  assert.equal(commands(ctx, 'lock').length, 1);
});

test('lock: never sent (bridge down) is kept, never counted, never given up; goes when the bridge is back', async (t) => {
  const ctx = await setup(t);
  await ctx.bridge.unplug();
  const pressed = press(ctx, 'lock');
  for (let i = 0; i < 10; i += 1) await ctx.clock.advance(TIMINGS.lockRetryGap);
  const ack = await pressed;
  assert.equal(ack.success, false);
  assert.match(ack.error, /not sent yet/);
  assert.equal(ctx.store.data.pendingLock.sends, 0);
  for (let i = 0; i < 20; i += 1) {
    await ctx.clock.advance(TIMINGS.lockPendingRead);
    await settle(20);
  }
  assert.equal(ctx.store.data.pendingLock.sends, 0, 'nothing left: no try counted');
  await ctx.bridge.plug();
  await ctx.clock.advance(TIMINGS.lockPendingRead);
  await waitFor(() => commands(ctx, 'lock').length === 1, { what: 'sent when back' });
  await ctx.clock.advance(TIMINGS.followUps[1]);
  await waitFor(() => ctx.store.data.pendingLock === null, { what: 'confirmed' });
});

test('lock: answered errors are not tries (never given up); 2xx unconfirmed: 3 sends then given up', async (t) => {
  const ctx = await setup(t, { bridge: { commandMode: 500 } });
  await press(ctx, 'lock');
  for (let i = 0; i < 12; i += 1) {
    await ctx.clock.advance(TIMINGS.lockPendingRead);
    await settle(20);
  }
  assert.ok(commands(ctx, 'lock').length >= 4, 'sent again and again');
  assert.equal(ctx.store.data.pendingLock.sends, 0);
  ctx.bridge.commandMode = 'ok';
  ctx.bridge.ignore = true;
  for (let i = 0; i < 12 && ctx.store.data.pendingLock; i += 1) {
    await ctx.clock.advance(TIMINGS.lockPendingRead);
    await settle(20);
  }
  assert.equal(ctx.store.data.pendingLock, null);
  assert.equal(commands(ctx, 'lock').filter((c) => c.valid).length >= 3, true);
  assert.match(last(ctx.gladys, 'last_command'), /3 times/);
});

test('lock: a send without answer is not a try; read again and sent again', async (t) => {
  const ctx = await setup(t, { bridge: { commandMode: 'silent' } });
  const pressed = press(ctx, 'lock');
  await waitFor(() => commands(ctx).length === 1);
  await ctx.clock.advance(TIMINGS.commandTimeout);
  const ack = await pressed;
  assert.equal(ack.success, false);
  assert.match(ack.error, /without an answer/);
  assert.equal(ctx.store.data.pendingLock.sends, 0);
  ctx.bridge.commandMode = 'ok';
  await ctx.clock.advance(TIMINGS.lockPendingRead);
  await waitFor(() => commands(ctx).length === 2, { what: 'sent again' });
});

test('lock: key refused (401): kept, no automatic send; a new key sends it first', async (t) => {
  const ctx = await setup(t, { bridge: { localKey: 'AAAAAAAAAAAAAAAAAAAAAA==' } });
  const ack = await press(ctx, 'lock');
  assert.equal(ack.success, false);
  assert.match(ack.error, /refused the local key/);
  assert.ok(ctx.store.data.keyRefused);
  for (let i = 0; i < 5; i += 1) await ctx.clock.advance(TIMINGS.lockPendingRead);
  assert.equal(commands(ctx).length, 1, 'no automatic send');
  // A click still sends once (not automatic), and stays refused.
  assert.equal((await press(ctx, 'lock')).success, false);
  assert.equal(commands(ctx).length, 2, 'a click sends');
  // Unlocking is refused before any read while the key is refused.
  ctx.app.config.allowUnlock = true;
  const reads = ctx.bridge.count('/status');
  const refused = await press(ctx, 'unlock');
  assert.match(refused.error, /refused the local key/);
  assert.equal(ctx.bridge.count('/status'), reads, 'no read');
  ctx.app.config.allowUnlock = false;
  ctx.bridge.localKey = 'AAAAAAAAAAAAAAAAAAAAAA==';
  await ctx.gladys.fake.configUpdated({
    ...ctx.gladys.fake.config,
    local_key: 'AAAAAAAAAAAAAAAAAAAAAA==',
  });
  await waitFor(() => commands(ctx).length === 3, { what: 'sent with the new key' });
  assert.equal(commands(ctx)[2].valid, true);
  assert.equal(ctx.store.data.keyRefused, null);
});

test('lock: key refused, then a successful test sends it first', async (t) => {
  const ctx = await setup(t, { bridge: { localKey: 'AAAAAAAAAAAAAAAAAAAAAA==' } });
  await press(ctx, 'lock');
  ctx.bridge.localKey = ctx.gladys.fake.config.local_key; // the bridge accepts it again
  const answer = await ctx.gladys.fake.action('test_connection', {});
  assert.equal(answer.success, true);
  assert.equal(commands(ctx).length, 2);
  assert.equal(commands(ctx)[1].valid, true);
});

test('lock: a refused key is a refusal of THAT key across a restart (salted tag), lifted by another', async (t) => {
  const ctx = await setup(t, { bridge: { localKey: 'AAAAAAAAAAAAAAAAAAAAAA==' } });
  await press(ctx, 'lock');
  const kept = JSON.parse(JSON.stringify(ctx.store.data));
  assert.ok(!JSON.stringify(kept).includes(ctx.gladys.fake.config.local_key));
  ctx.app.stop();
  // Same key after a restart: still refused, nothing sent by itself.
  const again = await setup(t, {
    memory: kept,
    created: false,
    bridge: { localKey: 'AAAAAAAAAAAAAAAAAAAAAA==' },
  });
  await again.clock.advance(TIMINGS.lockPendingRead);
  assert.equal(commands(again).length, 0);
  // Another key saved while stopped: sent at the start.
  const other = await setup(t, {
    memory: kept,
    created: false,
    config: { local_key: 'AAAAAAAAAAAAAAAAAAAAAA==' },
    bridge: { localKey: 'AAAAAAAAAAAAAAAAAAAAAA==' },
  });
  await waitFor(() => commands(other).length === 1, { what: 'sent with the other key' });
});

test('restart: a waiting lock leaves before any read', async (t) => {
  const ctx = await setup(t, {
    memory: { mac: MAC, pendingLock: { at: Date.UTC(2026, 10, 5, 11), sends: 2 } },
    created: false,
  });
  await waitFor(() => commands(ctx).length === 1);
  const lockAt = ctx.bridge.requests.findIndex((r) => r.path === '/to_lock');
  const readAt = ctx.bridge.requests.findIndex((r) => r.path === '/status');
  assert.ok(readAt === -1 || lockAt < readAt, 'the lock first');
});

test('restart: an odd pending record still sends (count 0, future date = now)', async (t) => {
  const ctx = await setup(t, {
    memory: { mac: MAC, pendingLock: { at: Date.UTC(2030, 0, 1), sends: 'x' } },
    created: false,
  });
  await waitFor(() => commands(ctx).length === 1);
  assert.equal(commands(ctx)[0].valid, true);
  await waitFor(
    () => ctx.store.data.pendingLock?.sends === 1 || ctx.store.data.pendingLock === null,
  );
});

test('unlock and open: off by default, nothing sent', async (t) => {
  const ctx = await setup(t, { bridge: { bolt: 'night_lock' } });
  const reads = ctx.bridge.count('/status');
  for (const key of ['unlock', 'open']) {
    const ack = await press(ctx, key);
    assert.equal(ack.success, false);
    assert.match(ack.error, /off/);
  }
  assert.equal(commands(ctx).length, 0);
  assert.equal(ctx.bridge.count('/status'), reads, 'refused before any read');
});

test('open needs both options; allow_open alone refuses', async (t) => {
  const ctx = await setup(t, { config: { allow_open: true }, bridge: { bolt: 'night_lock' } });
  const ack = await press(ctx, 'open');
  assert.equal(ack.success, false);
  assert.equal(commands(ctx).length, 0);
});

test('unlock allowed: decided on a read started after the click, guard in /data first, confirmed', async (t) => {
  const ctx = await setup(t, { config: { allow_unlock: true }, bridge: { bolt: 'night_lock' } });
  const reads = ctx.bridge.count('/status');
  const savesBefore = ctx.store.saves;
  const ack = await press(ctx, 'unlock');
  assert.equal(ack.success, true);
  assert.equal(ctx.bridge.count('/status'), reads + 1, 'a fresh read');
  assert.ok(ctx.store.saves > savesBefore, 'the guard was written');
  const [command] = commands(ctx);
  assert.equal(command.action, 'unlock');
  assert.equal(command.valid, true);
  await ctx.clock.advance(TIMINGS.followUps[0]);
  await waitFor(() => last(ctx.gladys, 'last_command') === 'Unlocked (confirmed by the lock).');
  assert.equal(ctx.store.data.sensitive, null);
});

test('a read equal to the state before is not a confirmation (slow motor)', async (t) => {
  const ctx = await setup(t, {
    config: { allow_unlock: true },
    bridge: { bolt: 'night_lock', motorMs: 150 },
  });
  await press(ctx, 'unlock');
  await ctx.clock.advance(TIMINGS.followUps[0]);
  await settle(20);
  assert.equal(last(ctx.gladys, 'state'), 1, 'still locked');
  assert.equal(last(ctx.gladys, 'last_command'), 'Unlock sent; waiting for the lock to confirm.');
  await new Promise((resolve) => setTimeout(resolve, 200));
  await ctx.clock.advance(TIMINGS.followUps[1] - TIMINGS.followUps[0]);
  await waitFor(() => last(ctx.gladys, 'last_command') === 'Unlocked (confirmed by the lock).');
});

test('lock with a slow motor: not sent again before 6 s, confirmed by a later read', async (t) => {
  const ctx = await setup(t, { bridge: { motorMs: 150 } });
  await press(ctx, 'lock');
  await ctx.clock.advance(TIMINGS.followUps[1]);
  await settle(20);
  assert.equal(commands(ctx).length, 1, 'not again within 6 s of the send');
  await new Promise((resolve) => setTimeout(resolve, 200));
  await ctx.clock.advance(TIMINGS.followUps[2] - TIMINGS.followUps[1]);
  await waitFor(() => ctx.store.data.pendingLock === null);
  assert.equal(commands(ctx).length, 1);
});

test('open allowed by both options: sent', async (t) => {
  const ctx = await setup(t, { config: { allow_unlock: true, allow_open: true } });
  const ack = await press(ctx, 'open');
  assert.equal(ack.success, true);
  assert.equal(commands(ctx, 'open').length, 1);
});

test('unlock: already unlocked, nothing sent', async (t) => {
  const ctx = await setup(t, { config: { allow_unlock: true } });
  const ack = await press(ctx, 'unlock');
  assert.equal(ack.success, true);
  assert.equal(commands(ctx).length, 0);
});

test('unlock refused: lock waiting, lock offline, moving or unknown, read failed, other bridge', async (t) => {
  const ctx = await setup(t, { config: { allow_unlock: true }, bridge: { bolt: 'night_lock' } });
  ctx.bridge.commandMode = 'silent';
  const locking = press(ctx, 'lock');
  await waitFor(() => commands(ctx).length === 1);
  let ack = await press(ctx, 'unlock');
  assert.match(ack.error, /lock is in progress/);
  await ctx.clock.advance(TIMINGS.commandTimeout);
  await locking;
  ctx.app.memory.pendingLock = null;
  ctx.bridge.commandMode = 'ok';
  ctx.bridge.online = 0;
  ack = await press(ctx, 'unlock');
  assert.match(ack.error, /not connected/);
  ctx.bridge.online = 1;
  for (const bolt of ['unknown', 'motor_stall']) {
    ctx.bridge.bolt = bolt;
    ack = await press(ctx, 'unlock');
    assert.match(ack.error, /moving, jammed or in an unknown state/, bolt);
  }
  ctx.bridge.bolt = 'night_lock';
  ctx.bridge.statusMode = 503;
  ack = await press(ctx, 'unlock');
  assert.match(ack.error, /could not be read/);
  ctx.bridge.statusMode = 'ok';
  // The 503 paused the reads: unlocking is refused until the pause ends.
  ack = await press(ctx, 'unlock');
  assert.match(ack.error, /asked to wait/);
  await ctx.clock.advance(TIMINGS.pauseMin);
  ctx.bridge.mac = OTHER_MAC;
  ack = await press(ctx, 'unlock');
  assert.match(ack.error, /not the one of this device/);
  assert.equal(commands(ctx, 'unlock').length, 0);
});

test('unlock refused when the guard cannot be written to /data (failing or stuck)', async (t) => {
  const ctx = await setup(t, { config: { allow_unlock: true }, bridge: { bolt: 'night_lock' } });
  ctx.store.failing = true;
  let ack = await press(ctx, 'unlock');
  assert.match(ack.error, /\/data/);
  ctx.store.failing = false;
  ctx.store.hang = true;
  const pressed = press(ctx, 'unlock');
  await waitFor(() => ctx.bridge.count('/status') >= 3);
  await settle(20);
  await ctx.clock.advance(TIMINGS.commandSaveBy);
  ack = await pressed;
  assert.match(ack.error, /\/data/);
  assert.equal(commands(ctx).length, 0);
});

test('unlock: a lock clicked during its read cancels it; nothing sent after the lock', async (t) => {
  const ctx = await setup(t, {
    config: { allow_unlock: true },
    bridge: { bolt: 'night_lock', statusDelay: 50 },
  });
  const unlocking = press(ctx, 'unlock');
  await waitFor(() => ctx.bridge.count('/status') >= 2);
  await press(ctx, 'lock');
  const ack = await unlocking;
  assert.match(ack.error, /a lock was asked meanwhile/);
  assert.deepEqual(
    commands(ctx).map((c) => c.action),
    ['lock'],
  );
});

test('unlock: the option turned off while it waits for /data is checked again before the first byte', async (t) => {
  const ctx = await setup(t, { config: { allow_unlock: true }, bridge: { bolt: 'night_lock' } });
  let release;
  const save = ctx.store.save.bind(ctx.store);
  ctx.store.save = (data) =>
    data.sensitive ? new Promise((resolve) => (release = () => resolve(save(data)))) : save(data);
  const unlocking = press(ctx, 'unlock');
  await waitFor(() => release);
  ctx.app.config.allowUnlock = false;
  release();
  const ack = await unlocking;
  assert.match(ack.error, /off/);
  assert.equal(commands(ctx).length, 0);
});

test('unlock: a lock clicked while it waits for /data: nothing sent after the lock', async (t) => {
  const ctx = await setup(t, { config: { allow_unlock: true }, bridge: { bolt: 'night_lock' } });
  let release;
  const save = ctx.store.save.bind(ctx.store);
  ctx.store.save = (data) =>
    data.sensitive && !release
      ? new Promise((resolve) => (release = () => resolve(save(data))))
      : save(data);
  const unlocking = press(ctx, 'unlock');
  await waitFor(() => release);
  await press(ctx, 'lock');
  release();
  const ack = await unlocking;
  assert.equal(ack.success, false);
  assert.deepEqual(
    commands(ctx).map((c) => c.action),
    ['lock'],
  );
});

test('unlock: too late after the click (slow read) is refused, nothing sent', async (t) => {
  const ctx = await setup(t, { config: { allow_unlock: true }, bridge: { bolt: 'night_lock' } });
  ctx.bridge.statusMode = 'silent';
  const pressed = press(ctx, 'unlock');
  await waitFor(() => ctx.bridge.count('/status') >= 2);
  await ctx.clock.advance(TIMINGS.commandReadBy);
  const ack = await pressed;
  assert.equal(ack.success, false);
  assert.equal(commands(ctx).length, 0);
});

test('unlock: past 3.5 s once the guard is written, refused before even connecting', async (t) => {
  const ctx = await setup(t, { config: { allow_unlock: true }, bridge: { bolt: 'night_lock' } });
  let release;
  const save = ctx.store.save.bind(ctx.store);
  ctx.store.save = (data) =>
    data.sensitive ? new Promise((resolve) => (release = () => resolve(save(data)))) : save(data);
  const pressed = press(ctx, 'unlock');
  await waitFor(() => release);
  // Within the 2 s bound of a save.
  await ctx.clock.advance(TIMINGS.storeTimeout - 100);
  const connections = ctx.bridge.connections;
  // The save ends in its bound, then the event loop stalls past 3.5 s.
  release();
  ctx.clock.jump(TIMINGS.commandSendBy - TIMINGS.storeTimeout + 200);
  const ack = await pressed;
  assert.match(ack.error, /could not leave in time/);
  assert.equal(ctx.bridge.connections, connections, 'no connection opened');
  assert.equal(commands(ctx).length, 0);
});

test('unlock: past 3.5 s when the connection opens, refused in beforeSend, no byte', async (t) => {
  const ctx = await setup(t, { config: { allow_unlock: true }, bridge: { bolt: 'night_lock' } });
  ctx.app.request = async (options) => {
    if (options.path.startsWith('/to_lock')) ctx.clock.jump(TIMINGS.commandSendBy + 100);
    return bridgeRequest(options);
  };
  const ack = await press(ctx, 'unlock');
  assert.match(ack.error, /could not leave in time/);
  assert.equal(commands(ctx).length, 0);
});

test('unlock: a key refused while it connects is checked in beforeSend, no byte', async (t) => {
  const ctx = await setup(t, { config: { allow_unlock: true }, bridge: { bolt: 'night_lock' } });
  ctx.app.request = async (options) => {
    if (options.path.startsWith('/to_lock')) ctx.app.memory.keyRefused = { tag: null, salt: null };
    return bridgeRequest(options);
  };
  const ack = await press(ctx, 'unlock');
  assert.match(ack.error, /refused the local key/);
  assert.equal(commands(ctx).length, 0);
});

test('unlock: a lock clicked while it connects is checked in beforeSend, no byte', async (t) => {
  const ctx = await setup(t, { config: { allow_unlock: true }, bridge: { bolt: 'night_lock' } });
  let locking;
  let once = false;
  ctx.app.request = async (options) => {
    if (options.path.startsWith('/to_lock') && !once) {
      once = true;
      // The lock click lands while the unlock opens its connection.
      locking = ctx.app.lockClicked().catch(() => {});
    }
    return bridgeRequest(options);
  };
  const ack = await press(ctx, 'unlock');
  assert.match(ack.error, /a lock was asked meanwhile/);
  await locking;
  assert.deepEqual(
    commands(ctx).map((c) => c.action),
    ['lock'],
  );
});

test('unlock: a second one while the first is out is refused (one at a time)', async (t) => {
  const ctx = await setup(t, {
    config: { allow_unlock: true },
    bridge: { bolt: 'night_lock', statusDelay: 30 },
  });
  const first = press(ctx, 'unlock');
  await waitFor(() => ctx.bridge.count('/status') >= 2);
  const second = await press(ctx, 'unlock');
  assert.match(second.error, /another command/);
  assert.equal((await first).success, true);
  assert.equal(commands(ctx).length, 1);
});

test('unlock: sent without an answer is neither a success nor "nothing sent"', async (t) => {
  const ctx = await setup(t, {
    config: { allow_unlock: true },
    bridge: { bolt: 'night_lock', commandMode: 'silent' },
  });
  const pressed = press(ctx, 'unlock');
  await waitFor(() => commands(ctx).length === 1);
  await ctx.clock.advance(TIMINGS.commandTimeout);
  const ack = await pressed;
  assert.equal(ack.success, false);
  assert.match(ack.error, /without confirmation/);
});

test('a read started before a command is never applied after it', async (t) => {
  const ctx = await setup(t, { config: { allow_unlock: true }, bridge: { bolt: 'night_lock' } });
  // A periodic read leaves and answers late with the state before the unlock.
  ctx.bridge.statusDelay = 80;
  const reading = ctx.app.read();
  await waitFor(() => ctx.bridge.count('/status') >= 2);
  ctx.bridge.statusDelay = 0;
  const before = ctx.gladys.fake.states.length;
  const ack = await press(ctx, 'unlock');
  assert.equal(ack.success, true);
  await waitFor(() => ctx.bridge.bolt === 'day_lock');
  await reading;
  const applied = ctx.gladys.fake.states
    .slice(before)
    .filter((s) => s.device_feature_external_id === fid('state'));
  assert.ok(
    applied.every((s) => s.state !== 1),
    'the late "locked" read was not applied',
  );
});

test('reads apply in the order they started, never the order they answered', async (t) => {
  const ctx = await setup(t);
  ctx.bridge.statusDelay = 80;
  const slow = ctx.app.readOnce();
  await waitFor(() => ctx.bridge.count('/status') >= 2);
  ctx.bridge.statusDelay = 0;
  ctx.bridge.bolt = 'open';
  await ctx.app.readOnce();
  ctx.bridge.bolt = 'night_lock';
  assert.equal(await slow, undefined, 'the older read is dropped');
  assert.equal(last(ctx.gladys, 'position'), 'Open (latch pulled)');
});

test('another bridge at the address: not published, sensitive refused, adopted by two clicks', async (t) => {
  const ctx = await setup(t, { config: { allow_unlock: true } });
  ctx.bridge.mac = OTHER_MAC;
  await ctx.app.read();
  assert.equal(ctx.app.memory.otherMac, OTHER_MAC);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  let answer = await ctx.gladys.fake.action('adopt_bridge', {});
  assert.match(answer.data.message, /again within a minute/);
  answer = await ctx.gladys.fake.action('adopt_bridge', {});
  assert.match(answer.data.message, /now used/);
  assert.equal(ctx.store.data.mac, OTHER_MAC);
  assert.equal(ctx.gladys.fake.discoveredDevices[0].external_id, `ext:loqed:bridge:${OTHER_MAC}`);
});

test('/data unreadable: no identity learnt, nothing written, unlock refused, lock still goes', async (t) => {
  const ctx = await setup(t, {
    config: { allow_unlock: true },
    created: false,
    start: false,
    bridge: { bolt: 'night_lock' },
  });
  ctx.store.unreadable = true;
  await ctx.gladys.connect();
  await ctx.clock.advance(0);
  await waitFor(() => ctx.bridge.count('/status') >= 1);
  await settle(20);
  assert.equal(ctx.app.memory.mac, null);
  assert.equal(ctx.store.saves, 0);
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 0);
  let ack = await press(ctx, 'unlock');
  assert.match(ack.error, /\/data/);
  ack = await press(ctx, 'lock');
  assert.equal(ack.success, true);
  assert.equal(ctx.store.saves, 0);
});

test('getConfig failing in "connected" is tried again until it works', async (t) => {
  const ctx = await setup(t, { start: false, created: false });
  let calls = 0;
  const real = ctx.gladys.getConfig.bind(ctx.gladys);
  ctx.gladys.getConfig = async () => {
    calls += 1;
    // The first call is the resynchronization of connect(); the next two fail.
    if (calls === 2 || calls === 3) throw new Error('boom');
    return real();
  };
  const connecting = ctx.gladys.connect();
  await waitFor(() => calls === 2);
  await settle(10);
  assert.equal(ctx.app.started, false);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  await ctx.clock.advance(TIMINGS.configRetry[0]);
  await ctx.clock.advance(TIMINGS.configRetry[1]);
  await waitFor(() => ctx.app.started, { what: 'started' });
  await connecting;
  await ctx.clock.advance(0);
  await waitFor(() => ctx.gladys.fake.discoveredDevices.length === 1);
});

test('never faster than the interval across a restart; secrets never in logs, /data, statuses', async (t) => {
  const ctx = await setup(t);
  const kept = JSON.parse(JSON.stringify(ctx.store.data));
  await press(ctx, 'lock');
  const all = [
    JSON.stringify(ctx.store.data),
    JSON.stringify(ctx.gladys.fake.connectionStatuses),
    JSON.stringify(ctx.gladys.fake.states),
    ctx.logs.join('\n'),
  ].join('\n');
  for (const secret of ['local_key', 'bridge_key', 'webhook_token', 'channel_token']) {
    assert.ok(!all.includes(ctx.gladys.fake.config[secret]), secret);
  }
  ctx.app.stop();
  const again = await setup(t, {
    memory: { ...kept, lastTry: ctx.clock.now() - 1000 },
    created: false,
  });
  await again.clock.advance(1000);
  assert.equal(again.bridge.count('/status'), 0, 'not before the interval');
  await again.clock.advance(30_000);
  await waitFor(() => again.bridge.count('/status') === 1);
});

test('stop: no timer and no request afterwards', async (t) => {
  const ctx = await setup(t);
  await press(ctx, 'lock');
  ctx.app.stop();
  const requests = ctx.bridge.requests.length;
  await ctx.clock.advance(10 * 60_000);
  await settle(20);
  assert.equal(ctx.bridge.requests.length, requests);
  assert.equal(ctx.clock.pending, 0);
});

test('a read answered just before a lock click never confirms that lock', async (t) => {
  const ctx = await setup(t, { bridge: { bolt: 'night_lock' } });
  // A read whose answer is already in (the abort of the lock cannot cut it),
  // and a lock that cannot leave (so no command is numbered meanwhile).
  let answer;
  ctx.app.request = (options) => {
    if (options.path === '/status' && !answer) {
      return new Promise((resolve) => (answer = resolve));
    }
    if (options.path.startsWith('/to_lock')) {
      return Promise.reject(new BridgeError(ERROR_KINDS.NETWORK, 'refused', { notSent: true }));
    }
    return bridgeRequest(options);
  };
  const reading = ctx.app.readOnce();
  await waitFor(() => answer);
  const pressed = press(ctx, 'lock');
  for (let i = 0; i < 6; i += 1) await ctx.clock.advance(TIMINGS.lockRetryGap);
  await pressed;
  answer({
    status: 200,
    json: { bridge_mac_wifi: MAC, bolt_state: 'night_lock', lock_online: 1 },
  });
  assert.equal(await within(reading, 2000), undefined, 'not applied');
  assert.ok(ctx.store.data.pendingLock, 'the lock still waits');
});

test('a lock that cannot connect is tried again within 250 ms', async (t) => {
  const ctx = await setup(t);
  let refusals = 2;
  ctx.app.request = (options) => {
    if (options.path.startsWith('/to_lock') && refusals > 0) {
      refusals -= 1;
      return Promise.reject(new BridgeError(ERROR_KINDS.NETWORK, 'refused', { notSent: true }));
    }
    return bridgeRequest(options);
  };
  const pressed = press(ctx, 'lock');
  for (let i = 0; i < 3; i += 1) await ctx.clock.advance(TIMINGS.lockRetryGap);
  const ack = await pressed;
  assert.equal(ack.success, true);
  assert.equal(commands(ctx).length, 1);
});

test('a lock that never left is sent by the waiting round even when reads hang', async (t) => {
  const ctx = await setup(t);
  await ctx.bridge.unplug();
  const pressed = press(ctx, 'lock');
  for (let i = 0; i < 10; i += 1) await ctx.clock.advance(TIMINGS.lockRetryGap);
  assert.equal((await pressed).success, false);
  await ctx.bridge.plug();
  ctx.bridge.statusMode = 'silent';
  await ctx.clock.advance(TIMINGS.lockPendingRead);
  await waitFor(() => commands(ctx).length === 1, { what: 'sent by the round' });
});

test('an unlock is confirmed only by a read started after it left', async (t) => {
  const ctx = await setup(t);
  ctx.app.lastSensitive = { action: 'unlock', mono: 100, confirmed: false };
  ctx.app.confirmCommands('unlocked', 99);
  assert.equal(ctx.app.lastSensitive.confirmed, false);
  ctx.app.confirmCommands('unlocked', 101);
  assert.equal(ctx.app.lastSensitive.confirmed, true);
});

test('unlock of a device of another bridge: refused before any read', async (t) => {
  const ctx = await setup(t, { config: { allow_unlock: true }, bridge: { bolt: 'night_lock' } });
  const reads = ctx.bridge.count('/status');
  const ack = await press(ctx, 'unlock', OTHER_MAC);
  assert.match(ack.error, /not the one of this device/);
  assert.equal(ctx.bridge.count('/status'), reads);
});

test('no valid local key: unlock refused, the lock kept until a key is saved', async (t) => {
  const ctx = await setup(t, {
    config: { allow_unlock: true, local_key: '' },
    bridge: { bolt: 'night_lock' },
  });
  let ack = await press(ctx, 'unlock');
  assert.match(ack.error, /no valid key id or local key/);
  ack = await press(ctx, 'lock');
  assert.match(ack.error, /Lock kept/);
  assert.equal(commands(ctx).length, 0);
  await ctx.gladys.fake.configUpdated({
    ...ctx.gladys.fake.config,
    local_key: 'SGFsbG8gd2VyZWxkSGFsbG8gd2VyZWxkMTIzNDU2Nzg=',
  });
  await waitFor(() => commands(ctx).length === 1);
});

test('a 429 pauses the scheduled reads (60 s at least), not the lock', async (t) => {
  const ctx = await setup(t);
  ctx.bridge.statusMode = 429;
  await ctx.clock.advance(30_000);
  await waitFor(() => ctx.app.failures === 1);
  const reads = ctx.bridge.count('/status');
  ctx.bridge.statusMode = 'ok';
  await ctx.clock.advance(55_000);
  assert.equal(ctx.bridge.count('/status'), reads, 'paused');
  assert.ok(ctx.store.data.pausedUntil > ctx.clock.now());
  await ctx.clock.advance(10_000);
  await waitFor(() => ctx.bridge.count('/status') === reads + 1);
});

test('a read that stays 1 s without a byte is cut and counted as a failure', async (t) => {
  const ctx = await setup(t);
  ctx.bridge.statusMode = 'silent';
  const reading = ctx.app.readOnce();
  await waitFor(() => ctx.bridge.count('/status') >= 2);
  await ctx.clock.advance(TIMINGS.stallTimeout);
  assert.equal(await within(reading, 2000), undefined);
  assert.equal(ctx.app.failures, 1);
  assert.equal(ctx.gladys.fake.transports.at(-1).transport, 'unreachable');
});

test('a read started between the decision read and the send of an unlock is never applied', async (t) => {
  const ctx = await setup(t, { config: { allow_unlock: true }, bridge: { bolt: 'night_lock' } });
  let answer;
  let reading;
  let hold = false;
  ctx.app.request = (options) => {
    if (options.path === '/status' && hold && !answer) {
      return new Promise((resolve) => (answer = resolve));
    }
    if (options.path.startsWith('/to_lock') && !hold) {
      // A periodic read leaves after the decision read, before the unlock.
      hold = true;
      reading = ctx.app.readOnce();
    }
    return bridgeRequest(options);
  };
  const ack = await press(ctx, 'unlock');
  assert.equal(ack.success, true);
  await waitFor(() => answer);
  const before = ctx.gladys.fake.states.length;
  answer({
    status: 200,
    json: { bridge_mac_wifi: MAC, bolt_state: 'night_lock', lock_online: 1 },
  });
  assert.equal(await within(reading, 2000), undefined, 'not applied');
  assert.equal(ctx.gladys.fake.states.length, before);
});

test('during a pause, no read even when the interval is changed', async (t) => {
  const ctx = await setup(t);
  ctx.bridge.statusMode = 429;
  await ctx.clock.advance(30_000);
  await waitFor(() => ctx.app.failures === 1);
  const reads = ctx.bridge.count('/status');
  ctx.bridge.statusMode = 'ok';
  await ctx.gladys.fake.configUpdated({ ...ctx.gladys.fake.config, poll_interval: 10 });
  await ctx.clock.advance(15_000);
  await settle(20);
  assert.equal(ctx.bridge.count('/status'), reads);
});

test('B1: a lock clicked while getConfig() fails at the start leaves once the configuration comes', async (t) => {
  const ctx = await setup(t, { start: false, created: false, memory: { mac: MAC } });
  let calls = 0;
  const real = ctx.gladys.getConfig.bind(ctx.gladys);
  ctx.gladys.getConfig = async () => {
    calls += 1;
    if (calls === 2) throw new Error('boom');
    return real();
  };
  const connecting = ctx.gladys.connect();
  await waitFor(() => calls === 2);
  await settle(10);
  const ack = await press(ctx, 'lock');
  assert.match(ack.error, /Verrouillage gardé|Lock kept/);
  await ctx.clock.advance(TIMINGS.configRetry[0]);
  await connecting;
  await waitFor(() => commands(ctx, 'lock').length === 1, { what: 'the lock clicked before' });
  assert.equal(commands(ctx, 'lock')[0].valid, true);
  assert.ok(ctx.store.data.pendingLock, 'kept in /data');
});

test('B1: a lock clicked while /data is being read (bridge away) is merged, kept and sent', async (t) => {
  const base = memoryStore({ mac: MAC });
  let release;
  const store = {
    ...base,
    load() {
      if (!release) return new Promise((resolve) => (release = () => resolve(base.load())));
      return base.load();
    },
    save: (data) => base.save(data),
    get data() {
      return base.data;
    },
  };
  const ctx = await setup(t, { start: false, created: false, store });
  await ctx.bridge.unplug();
  const connecting = ctx.gladys.connect();
  await waitFor(() => release);
  const pressed = press(ctx, 'lock');
  for (let i = 0; i < 10; i += 1) await ctx.clock.advance(TIMINGS.lockRetryGap);
  assert.match((await pressed).error, /not sent yet/);
  release();
  await connecting;
  await waitFor(() => store.data.pendingLock, { what: 'merged and written' });
  await ctx.bridge.plug();
  await ctx.clock.advance(TIMINGS.lockPendingRead);
  await waitFor(() => commands(ctx, 'lock').length === 1, { what: 'sent when back' });
});

test('B2: /data slow once at the start is read again; its waiting lock then leaves', async (t) => {
  const store = memoryStore({ mac: MAC, pendingLock: { at: Date.UTC(2026, 10, 5, 11), sends: 0 } });
  store.hang = true;
  const ctx = await setup(t, { start: false, created: false, store });
  const connecting = ctx.gladys.connect();
  await settle(10);
  await ctx.clock.advance(TIMINGS.storeTimeout);
  await connecting;
  assert.equal(ctx.app.memoryState, 'unreadable');
  store.hang = false;
  await ctx.clock.advance(30_000);
  await waitFor(() => commands(ctx, 'lock').length === 1, { what: 'the kept lock' });
  assert.equal(ctx.app.memoryState, 'ok');
  await waitFor(() => ctx.gladys.fake.discoveredDevices.length === 1);
});

test('I1: exactly 3 sends answered 2xx, never given up after 1 or 2', async (t) => {
  const ctx = await setup(t, { bridge: { ignore: true } });
  await press(ctx, 'lock');
  const seen = [];
  for (let i = 0; i < 12 && ctx.store.data.pendingLock; i += 1) {
    await ctx.clock.advance(TIMINGS.lockPendingRead);
    await settle(20);
    seen.push([commands(ctx, 'lock').length, Boolean(ctx.store.data.pendingLock)]);
  }
  assert.equal(commands(ctx, 'lock').length, 3, JSON.stringify(seen));
  for (const [sent, waiting] of seen) {
    if (sent < 3) assert.equal(waiting, true, `given up after ${sent}`);
  }
  assert.equal(ctx.store.data.pendingLock, null);
});

test('I2: a pause holds follow-up reads, webhook reads and the test button; a waiting lock still reads', async (t) => {
  const ctx = await setup(t, { config: { poll_interval: 10 } });
  ctx.bridge.statusMode = 429;
  await ctx.clock.advance(10_000);
  await waitFor(() => ctx.app.failures === 1);
  ctx.bridge.statusMode = 'ok';
  const reads = ctx.bridge.count('/status');
  ctx.app.armFollowUps();
  await ctx.clock.advance(TIMINGS.followUps[1]);
  await ctx.app.read();
  const answer = await ctx.gladys.fake.action('test_connection', {});
  assert.match(answer.data.message, /asked to wait/);
  assert.equal(ctx.bridge.count('/status'), reads, 'nothing read during the pause');
  ctx.bridge.ignore = true;
  await press(ctx, 'lock');
  await ctx.clock.advance(TIMINGS.followUps[0]);
  await waitFor(() => ctx.bridge.count('/status') > reads, { what: 'the lock reads' });
});

test('m3: the decision read of an unlock is bounded by 2.5 s after the click', async (t) => {
  const ctx = await setup(t, { config: { allow_unlock: true }, bridge: { bolt: 'night_lock' } });
  const timeouts = [];
  ctx.app.request = (options) => {
    if (options.path === '/status') timeouts.push(options.timeout);
    return bridgeRequest(options);
  };
  await press(ctx, 'unlock');
  assert.equal(timeouts.length, 1);
  assert.ok(timeouts[0] > 0 && timeouts[0] <= TIMINGS.commandReadBy, String(timeouts[0]));
});

test('m5: the status says exactly where a waiting lock stands', async (t) => {
  const ctx = await setup(t);
  await ctx.bridge.unplug();
  const pressed = press(ctx, 'lock');
  for (let i = 0; i < 10; i += 1) await ctx.clock.advance(TIMINGS.lockRetryGap);
  await pressed;
  await ctx.app.read();
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /has not left yet/);
  await ctx.bridge.plug();
  ctx.bridge.ignore = true;
  await ctx.clock.advance(TIMINGS.lockPendingRead);
  await waitFor(() => commands(ctx).length === 1);
  await ctx.app.read();
  await waitFor(() => /was sent and waits/.test(ctx.gladys.fake.connectionStatus.message.en));
});

test('m6: the test button never reads faster than the interval', async (t) => {
  const ctx = await setup(t, { config: { poll_interval: 60 } });
  const reads = ctx.bridge.count('/status');
  let answer = await ctx.gladys.fake.action('test_connection', {});
  assert.match(answer.data.message, /answers/);
  assert.equal(ctx.bridge.count('/status'), reads, 'the read of the round is recent: used');
  await ctx.clock.advance(30_000);
  answer = await ctx.gladys.fake.action('test_connection', {});
  assert.match(answer.data.message, /a moment ago/);
  await ctx.clock.advance(31_000);
  const before = ctx.bridge.count('/status');
  answer = await ctx.gladys.fake.action('test_connection', {});
  assert.equal(answer.success, true);
  assert.ok(ctx.bridge.count('/status') <= before + 1, 'one read at most');
});

test('r2 I1: /data unreadable at the start is read again every 10 s, whatever the interval', async (t) => {
  const store = memoryStore({ mac: MAC, pendingLock: { at: Date.UTC(2026, 10, 5, 11), sends: 0 } });
  store.hang = true;
  const ctx = await setup(t, {
    start: false,
    created: false,
    store,
    config: { poll_interval: 600 },
  });
  const connecting = ctx.gladys.connect();
  await settle(10);
  await ctx.clock.advance(TIMINGS.storeTimeout);
  await connecting;
  // The first scheduled read (and its /data retry) passes while /data still hangs.
  await ctx.clock.advance(TIMINGS.storeTimeout + 100);
  assert.equal(ctx.app.memoryState, 'unreadable');
  store.hang = false;
  await ctx.clock.advance(TIMINGS.memoryRetry);
  await waitFor(() => commands(ctx, 'lock').length === 1, { what: 'the kept lock within 10 s' });
});

test('r2 I2: a lock clicked while getConfig() fails, then /data unreadable, still leaves', async (t) => {
  const store = memoryStore({ mac: MAC });
  const ctx = await setup(t, { start: false, created: false, store });
  let calls = 0;
  const real = ctx.gladys.getConfig.bind(ctx.gladys);
  ctx.gladys.getConfig = async () => {
    calls += 1;
    if (calls === 2) throw new Error('boom');
    return real();
  };
  const connecting = ctx.gladys.connect();
  await waitFor(() => calls === 2);
  await settle(10);
  await press(ctx, 'lock');
  store.unreadable = true;
  await ctx.clock.advance(TIMINGS.configRetry[0]);
  await connecting;
  assert.equal(ctx.app.memoryState, 'unreadable');
  await waitFor(() => commands(ctx, 'lock').length === 1, { what: 'the lock clicked before' });
});

test('r2 I2: /data readable again with the bridge away: its lock leaves when the bridge is back', async (t) => {
  const store = memoryStore({ mac: MAC, pendingLock: { at: Date.UTC(2026, 10, 5, 11), sends: 0 } });
  store.unreadable = true;
  const ctx = await setup(t, {
    start: false,
    created: false,
    store,
    config: { poll_interval: 600 },
  });
  await ctx.bridge.unplug();
  await ctx.gladys.connect();
  await settle(10);
  store.unreadable = false;
  await ctx.clock.advance(TIMINGS.memoryRetry);
  for (let i = 0; i < 10; i += 1) await ctx.clock.advance(TIMINGS.lockRetryGap);
  await waitFor(() => ctx.app.memoryState === 'ok');
  assert.equal(commands(ctx, 'lock').length, 0);
  await ctx.bridge.plug();
  await ctx.clock.advance(TIMINGS.lockPendingRead);
  await waitFor(() => commands(ctx, 'lock').length === 1, { what: 'sent by the 10 s round' });
});

test('r2 m1: the status tells at once that a lock has not left, without any read', async (t) => {
  const ctx = await setup(t, { config: { poll_interval: 600 } });
  await ctx.bridge.unplug();
  const reads = ctx.bridge.count('/status');
  const pressed = press(ctx, 'lock');
  for (let i = 0; i < 10; i += 1) await ctx.clock.advance(TIMINGS.lockRetryGap);
  await pressed;
  await waitFor(() => /has not left yet/.test(ctx.gladys.fake.connectionStatus.message?.en ?? ''));
  assert.equal(ctx.bridge.count('/status'), reads);
});

test('r2 m3: the waiting round sends a lock that never left without waiting for a stuck /data', async (t) => {
  const ctx = await setup(t);
  await ctx.bridge.unplug();
  const pressed = press(ctx, 'lock');
  for (let i = 0; i < 10; i += 1) await ctx.clock.advance(TIMINGS.lockRetryGap);
  await pressed;
  ctx.store.hang = true;
  ctx.app.memoryState = 'unreadable';
  await ctx.bridge.plug();
  await ctx.clock.advance(TIMINGS.lockPendingRead);
  await waitFor(() => commands(ctx, 'lock').length === 1, { what: 'sent, /data stuck' });
});

test('r2 m4: adopting is held by a pause', async (t) => {
  const ctx = await setup(t);
  ctx.bridge.statusMode = 429;
  await ctx.clock.advance(30_000);
  await waitFor(() => ctx.app.failures === 1);
  ctx.bridge.statusMode = 'ok';
  const reads = ctx.bridge.count('/status');
  const answer = await ctx.gladys.fake.action('adopt_bridge', {});
  assert.match(answer.data.message, /asked to wait/);
  assert.equal(ctx.bridge.count('/status'), reads);
});

test('r2 m4: a key refusal learnt while /data was unreadable survives its reading', async (t) => {
  const store = memoryStore({ mac: MAC });
  store.unreadable = true;
  const ctx = await setup(t, {
    start: false,
    created: false,
    store,
    bridge: { localKey: 'AAAAAAAAAAAAAAAAAAAAAA==' },
  });
  await ctx.gladys.connect();
  await settle(10);
  await press(ctx, 'lock');
  assert.ok(ctx.app.memory.keyRefused);
  store.unreadable = false;
  await ctx.clock.advance(TIMINGS.memoryRetry);
  await waitFor(() => ctx.app.memoryState === 'ok');
  assert.ok(ctx.app.memory.keyRefused, 'still refused');
  assert.ok(store.data.keyRefused, 'written');
  await ctx.clock.advance(TIMINGS.lockPendingRead);
  assert.equal(commands(ctx, 'lock').length, 1, 'no automatic send');
});

test('r2 m4: a click during the reading of /data wins over an older lock of /data (count back to 0)', async (t) => {
  const base = memoryStore({ mac: MAC, pendingLock: { at: Date.UTC(2026, 10, 5, 11), sends: 2 } });
  let release;
  const store = {
    load() {
      if (!release) return new Promise((resolve) => (release = () => resolve(base.load())));
      return base.load();
    },
    save: (data) => base.save(data),
  };
  const ctx = await setup(t, { start: false, created: false, store });
  await ctx.bridge.unplug();
  const connecting = ctx.gladys.connect();
  await waitFor(() => release);
  const pressed = press(ctx, 'lock');
  for (let i = 0; i < 10; i += 1) await ctx.clock.advance(TIMINGS.lockRetryGap);
  await pressed;
  release();
  await connecting;
  await waitFor(() => base.data.pendingLock?.sends === 0, { what: 'the click wins' });
});

test('r2 m2: a test that could not read does not hold the next one for the interval', async (t) => {
  const ctx = await setup(t, { config: { poll_interval: 600 } });
  await ctx.bridge.unplug();
  await ctx.app.read();
  let answer = await ctx.gladys.fake.action('test_connection', {});
  assert.match(answer.data.message, /does not answer/);
  await ctx.bridge.plug();
  answer = await ctx.gladys.fake.action('test_connection', {});
  assert.match(answer.data.message, /try again in \d+ s/);
  await ctx.clock.advance(TIMINGS.testCooldown);
  answer = await ctx.gladys.fake.action('test_connection', {});
  assert.match(answer.data.message, /answers/);
});

test('r2 m1: the status follows the lock result (sent without answer) without any read', async (t) => {
  const ctx = await setup(t, { config: { poll_interval: 600 }, bridge: { commandMode: 'silent' } });
  const pressed = press(ctx, 'lock');
  await waitFor(() => commands(ctx).length === 1);
  const reads = ctx.bridge.count('/status');
  await ctx.clock.advance(TIMINGS.commandTimeout);
  await pressed;
  await waitFor(() =>
    /was sent and waits/.test(ctx.gladys.fake.connectionStatus.message?.en ?? ''),
  );
  assert.equal(ctx.bridge.count('/status'), reads);
});
