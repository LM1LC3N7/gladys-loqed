// -----------------------------------------------------------------------------
// The app with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), a fake bridge on 127.0.0.1, a memory store, a fake
// channel to the receiver and the virtual clock. Everything is closed by
// t.after: a failing test never leaves a server or a timer behind.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { LoqedApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { BRIDGE_KEY, LOCAL_KEY, MAC, fakeBridge } from './bridge.js';
import { settle, testClock, waitFor, within } from './clock.js';

export const SELECTOR = 'loqed';
export const HOOK_PORT = 41234;
export const fid = (key, mac = MAC) => `ext:${SELECTOR}:bridge:${mac}:${key}`;
export const did = (mac = MAC) => `ext:${SELECTOR}:bridge:${mac}`;

export class FakeChannel extends EventEmitter {
  constructor() {
    super();
    this.started = 0;
    this.stopped = 0;
  }
  start() {
    this.started += 1;
  }
  stop() {
    this.stopped += 1;
  }
}

export function baseConfig(bridge, extra = {}) {
  return {
    bridge_address: bridge.address,
    key_id: 1,
    local_key: LOCAL_KEY,
    bridge_key: BRIDGE_KEY,
    allow_unlock: false,
    allow_open: false,
    callback_address: '192.168.1.10',
    check_webhook_source: true,
    poll_interval: 30,
    language: 'en',
    webhook_token: 'W'.repeat(32),
    channel_token: 'C'.repeat(32),
    ...extra,
  };
}

/**
 * @returns the app, the fake Gladys, the bridge, the store, the clock, the
 * channel and the logs. `start: false` leaves the connection to the test.
 */
export async function setup(
  t,
  {
    config = {},
    memory = null,
    bridge: bridgeOptions = {},
    start = true,
    created = true,
    store,
  } = {},
) {
  const bridge = await fakeBridge(bridgeOptions);
  const clock = testClock();
  const logs = [];
  const log = (level) => (text, err) =>
    logs.push(`${level} ${text}${err ? ` ${err.message}` : ''}`);
  const logger = { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') };
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: baseConfig(bridge, config),
    containers: [
      {
        name: 'loqed-webhook',
        status: 'running',
        ports: [
          { name: 'loqed_webhook', container_port: 8080, protocol: 'tcp', host_port: HOOK_PORT },
        ],
      },
    ],
  });
  const channel = new FakeChannel();
  const theStore = store ?? memoryStore(memory);
  const app = new LoqedApp({
    gladys,
    logger,
    store: theStore,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    createChannel: () => channel,
  });
  registerHandlers(gladys, app, logger);
  t.after(async () => {
    app.stop();
    await bridge.close();
  });
  // Requests in flight and the answers of the locks, for the counting tests.
  let inflight = 0;
  const lockAnswers = [];
  const request = app.request;
  app.request = (options) => {
    inflight += 1;
    const pending = request(options);
    const isLock = String(options.path).startsWith('/to_lock');
    pending.then(
      () => isLock && lockAnswers.push('2xx'),
      (err) => isLock && lockAnswers.push(err.notSent ? 'notSent' : (err.status ?? err.kind)),
    );
    return pending.finally(() => {
      inflight -= 1;
    });
  };
  const quiet = () => waitFor(() => inflight === 0, { what: 'requests in flight' });
  const ctx = {
    app,
    gladys,
    bridge,
    store: theStore,
    clock,
    channel,
    logs,
    lockAnswers,
    /** Advances the virtual time only while no request is in flight (no race with real I/O). */
    advance: (ms) => clock.advance(ms, { beforeFire: quiet }),
  };
  if (start) {
    await within(gladys.connect(), 3000, 'connect');
    await clock.advance(0);
    if (created) {
      await waitFor(() => gladys.fake.discoveredDevices.length > 0, { what: 'discovery' });
      gladys.fake.devices = [...gladys.fake.discoveredDevices];
      await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
    }
    await settle();
  }
  return ctx;
}

/** The value Gladys last received for a feature (number or text). */
export function last(gladys, key, mac = MAC) {
  const states = gladys.fake.states.filter((s) => s.device_feature_external_id === fid(key, mac));
  const state = states.at(-1);
  return state?.text ?? state?.state;
}

/** Presses a button feature; resolves the ack `{ success, error?, data? }`. */
export function press(ctx, key, mac = MAC) {
  const device = { external_id: did(mac) };
  return within(
    ctx.gladys.fake.setValue(device, { external_id: fid(key, mac) }, 1),
    4000,
    `press ${key}`,
  );
}

export { settle, waitFor, within };
