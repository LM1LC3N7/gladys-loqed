// -----------------------------------------------------------------------------
// Webhooks in the main container: the registration at the bridge (signed,
// our old URLs withdrawn, never another one), and every event checked before
// it counts: signature, time, replay, sender, bridge; around a command only a
// read decides; a waiting lock ends only on a movement clearly made later
// with another key.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MAC, signWebhook } from './helpers/bridge.js';
import { HOOK_PORT, last, press, settle, setup, waitFor } from './helpers/app.js';
import { TIMINGS } from '../src/constants.js';

const URL_OURS = `http://192.168.1.10:${HOOK_PORT}/loqed/${'W'.repeat(32)}`;

/** A webhook as the receiver hands it: signed by the bridge at `seconds`, received at `at`. */
function hook(ctx, json, { seconds, at, from = '127.0.0.1', key } = {}) {
  const body = JSON.stringify(json);
  const wall = ctx.clock.now();
  const signed = signWebhook(body, seconds ?? Math.floor(wall / 1000), key);
  return {
    type: 'webhook',
    from,
    at: new Date(at ?? wall).toISOString(),
    timestamp: signed.timestamp,
    hash: signed.hash,
    body: Buffer.from(body).toString('base64'),
  };
}

async function deliver(ctx, msg) {
  ctx.channel.emit('message', msg);
  await settle(20);
}

test('registration: the URL of the receiver, signed with the bridge key; our old URL withdrawn, never another', async (t) => {
  const oldUrl = `http://192.168.1.10:${HOOK_PORT}/loqed/${'X'.repeat(32)}`;
  const tag = createHash('sha256').update(oldUrl).digest('hex').slice(0, 8);
  const ctx = await setup(t, {
    memory: { mac: MAC, hooks: [tag] },
    bridge: {
      hooks: [
        { id: 7, url: oldUrl },
        { id: 8, url: 'http://10.0.0.2:8123/api/webhook/home-assistant' },
      ],
      nextHookId: 9,
    },
  });
  await waitFor(() => ctx.app.hookState === 'ok', { what: 'registered' });
  assert.deepEqual(
    ctx.bridge.hooks.map((h) => h.url),
    ['http://10.0.0.2:8123/api/webhook/home-assistant', URL_OURS],
  );
  assert.equal(ctx.bridge.hooks[1].trigger_online_status, 1);
  assert.deepEqual(ctx.store.data.hooks, [
    createHash('sha256').update(URL_OURS).digest('hex').slice(0, 8),
  ]);
  assert.ok(!JSON.stringify(ctx.store.data).includes('W'.repeat(32)), 'never the token in /data');
  assert.equal(ctx.channel.started, 1);
  const env = ctx.gladys.fake.requests.find((r) => r.path.includes('loqed-webhook'))?.body?.env;
  assert.equal(env?.DEVICE_ADDRESS, '127.0.0.1');
  assert.match(String(ctx.gladys.fake.connectionStatus.message?.en), /webhooks on/);
});

test('registration refused (wrong bridge key): secondary, the reads and commands go on', async (t) => {
  const ctx = await setup(t, { bridge: { bridgeKey: 'AAAAAAAA' } });
  await waitFor(() => ctx.app.hookState === 'refused');
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /refused the bridge key/);
  assert.equal((await press(ctx, 'lock')).success, true);
});

test('no bridge key or no Gladys address: no receiver, no webhook, the bridge is read', async (t) => {
  const ctx = await setup(t, { config: { callback_address: '' } });
  assert.equal(ctx.channel.started, 0);
  assert.equal(ctx.bridge.count('/webhooks'), 0);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /No Gladys address/);
});

test('a signed state event is applied at once; unsigned, late, replayed, foreign ones are not', async (t) => {
  const ctx = await setup(t);
  await ctx.clock.advance(TIMINGS.commandWindow);
  const locked = hook(ctx, {
    event_type: 'STATE_CHANGED_NIGHT_LOCK',
    key_local_id: 255,
    mac_wifi: MAC,
  });
  await deliver(ctx, locked);
  assert.equal(last(ctx.gladys, 'state'), 1);
  // Replayed: refused.
  ctx.bridge.bolt = 'day_lock';
  await deliver(ctx, locked);
  assert.equal(ctx.app.refusedWebhooks, 1);
  const open = { event_type: 'STATE_CHANGED_OPEN', key_local_id: 255 };
  const refusedCases = [
    { ...hook(ctx, open), hash: 'f'.repeat(64) },
    hook(ctx, open, { key: 'AAAAAAAA' }),
    hook(ctx, open, { seconds: Math.floor(ctx.clock.now() / 1000) - 31 }),
    hook(ctx, open, { from: '192.168.1.66' }),
    hook(ctx, { ...open, mac_wifi: '112233445566' }),
  ];
  for (const msg of refusedCases) await deliver(ctx, msg);
  assert.equal(ctx.app.refusedWebhooks, 6);
  assert.equal(last(ctx.gladys, 'state'), 1, 'still locked');
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /Webhooks refused/);
  // Kept too long by the receiver (dated after the start): ignored, no read.
  ctx.bridge.bolt = 'night_lock';
  await ctx.clock.advance(120_000);
  const reads = ctx.bridge.count('/status');
  await deliver(
    ctx,
    hook(ctx, open, {
      at: ctx.clock.now() - 61_000,
      seconds: Math.floor((ctx.clock.now() - 61_000) / 1000),
    }),
  );
  assert.equal(last(ctx.gladys, 'state'), 1);
  assert.equal(ctx.bridge.count('/status'), reads, 'not even a read');
  // A notice of the receiver about another sender.
  await deliver(ctx, { type: 'refused', from: '192.168.1.66', at: new Date().toISOString() });
  assert.equal(ctx.app.refusedWebhooks, 7);
});

test('the sender check off: another source address is accepted (signature still checked)', async (t) => {
  const ctx = await setup(t, { config: { check_webhook_source: false } });
  await ctx.clock.advance(TIMINGS.commandWindow);
  await deliver(ctx, hook(ctx, { event_type: 'STATE_CHANGED_NIGHT_LOCK' }, { from: '172.17.0.1' }));
  assert.equal(last(ctx.gladys, 'state'), 1);
  const env = ctx.gladys.fake.requests.find((r) => r.path.includes('loqed-webhook'))?.body?.env;
  assert.equal(env?.DEVICE_ADDRESS, undefined);
});

test('battery and online events; the lock away shows degraded', async (t) => {
  const ctx = await setup(t);
  await deliver(ctx, hook(ctx, { battery_type: 'NICKEL_METAL_HYDRIDE', battery_percentage: 55 }));
  assert.equal(last(ctx.gladys, 'battery'), 55);
  await deliver(ctx, hook(ctx, { ble_strength: -1, wifi_strength: 60 }));
  const badge = ctx.gladys.fake.transports.at(-1);
  assert.equal(badge.degraded, true);
  await deliver(ctx, hook(ctx, { battery_percentage: -1 }));
  assert.equal(last(ctx.gladys, 'battery'), 55, 'never -1 nor 0');
});

test('around a command, an event only triggers a read', async (t) => {
  const ctx = await setup(t);
  await press(ctx, 'lock');
  const reads = ctx.bridge.count('/status');
  ctx.bridge.bolt = 'day_lock';
  await deliver(ctx, hook(ctx, { event_type: 'STATE_CHANGED_OPEN', key_local_id: 255 }));
  await waitFor(() => ctx.bridge.count('/status') > reads);
  assert.notEqual(last(ctx.gladys, 'position'), 'Open (latch pulled)');
});

test('a waiting lock ends on a movement made clearly later with another key; never on our own key or a close time', async (t) => {
  const ctx = await setup(t, { bridge: { ignore: true } });
  await press(ctx, 'lock');
  const sent = ctx.app.lastLock.wall;
  // Our own key id: not an override.
  await ctx.clock.advance(3000);
  await deliver(
    ctx,
    hook(ctx, { event_type: 'GO_TO_STATE_MANUAL_UNLOCK_BLE_LATCH', key_local_id: 1 }),
  );
  assert.ok(ctx.store.data.pendingLock);
  // Another key but signed within 2 s of the send: in doubt, the lock stays.
  await deliver(
    ctx,
    hook(
      ctx,
      { event_type: 'GO_TO_STATE_MANUAL_UNLOCK_BLE_LATCH', key_local_id: 5 },
      { seconds: Math.floor(sent / 1000) },
    ),
  );
  assert.ok(ctx.store.data.pendingLock);
  // Another key toward night lock: not a contradiction.
  await deliver(
    ctx,
    hook(ctx, { event_type: 'GO_TO_STATE_MANUAL_LOCK_NIGHT_LOCK', key_local_id: 5 }),
  );
  assert.ok(ctx.store.data.pendingLock);
  // Another key, 3 s later on both clocks: the user unlocked with the app.
  await deliver(ctx, hook(ctx, { event_type: 'GO_TO_STATE_APP_UNLOCK_LATCH', key_local_id: 5 }));
  assert.equal(ctx.store.data.pendingLock, null);
  assert.match(last(ctx.gladys, 'last_command'), /another key/);
});

test('channel messages of an old generation and odd messages are ignored', async (t) => {
  const ctx = await setup(t);
  for (const msg of [
    null,
    'x',
    { type: 'other' },
    { type: 'webhook' },
    { type: 'webhook', at: 'x', body: 'e30=' },
  ]) {
    await deliver(ctx, msg);
  }
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
});

test('a lock still waiting long after its send: an event only triggers a read', async (t) => {
  const ctx = await setup(t, { bridge: { localKey: 'AAAAAAAAAAAAAAAAAAAAAA==' } });
  await press(ctx, 'lock'); // key refused: kept, never sent again by itself
  await ctx.clock.advance(TIMINGS.commandWindow + 5000);
  assert.ok(ctx.store.data.pendingLock);
  const reads = ctx.bridge.count('/status');
  await deliver(ctx, hook(ctx, { event_type: 'STATE_CHANGED_OPEN', key_local_id: 1 }));
  await waitFor(() => ctx.bridge.count('/status') > reads);
  assert.notEqual(last(ctx.gladys, 'position'), 'Open (latch pulled)');
});

test('m1: a webhook dated before this start (a replay after a restart) only triggers a read', async (t) => {
  const ctx = await setup(t);
  const startedSeconds = Math.floor(ctx.app.startedWall / 1000);
  await ctx.clock.advance(TIMINGS.commandWindow);
  const reads = ctx.bridge.count('/status');
  await deliver(
    ctx,
    hook(
      ctx,
      { event_type: 'STATE_CHANGED_OPEN', key_local_id: 255 },
      { seconds: startedSeconds - 1 },
    ),
  );
  await waitFor(() => ctx.bridge.count('/status') > reads);
  assert.notEqual(last(ctx.gladys, 'position'), 'Open (latch pulled)');
});
