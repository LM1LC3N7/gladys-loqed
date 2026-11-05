// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout) sped
// up 20 times, against the fake bridge: the reads really start at the
// interval (measured: never early, late by little), a lock sent during them
// is confirmed, and nothing runs after stop(). Every wait is bounded.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { LoqedApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { fakeBridge } from './helpers/bridge.js';
import { FakeChannel, baseConfig, fid, did } from './helpers/app.js';
import { waitFor, within } from './helpers/clock.js';

const SPEED = 20;

function realClock() {
  const live = new Set();
  let set = 0;
  return {
    now: () => Date.now() * SPEED,
    monotonic: () => performance.now() * SPEED,
    timers: {
      setTimeout(fn, ms) {
        set += 1;
        const h = setTimeout(
          () => {
            live.delete(h);
            fn();
          },
          Math.max(0, ms) / SPEED,
        );
        live.add(h);
        return h;
      },
      clearTimeout(h) {
        live.delete(h);
        clearTimeout(h);
      },
    },
    get live() {
      return live.size;
    },
    get set() {
      return set;
    },
    close() {
      for (const h of live) clearTimeout(h);
      live.clear();
    },
  };
}

test('real clock x20: reads at the interval, a lock confirmed, nothing after stop', async (t) => {
  const bridge = await fakeBridge();
  const clock = realClock();
  const quiet = () => {};
  const gladys = createFakeGladys({
    selector: 'loqed',
    config: baseConfig(bridge, { poll_interval: 10, callback_address: '' }),
  });
  const app = new LoqedApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    store: memoryStore(),
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    createChannel: () => new FakeChannel(),
  });
  registerHandlers(gladys, app);
  t.after(async () => {
    app.stop();
    clock.close();
    await bridge.close();
  });
  const reads = [];
  const poll = app.poll.bind(app);
  app.poll = () => {
    reads.push(clock.monotonic());
    return poll();
  };
  await within(gladys.connect(), 3000, 'connect');
  // 4 scheduled reads: 0, 10, 20, 30 s simulated = 1.5 s real.
  await waitFor(() => reads.length >= 4, { ms: 5000, what: 'four reads' });
  const gaps = reads.slice(1, 4).map((v, i) => v - reads[i]);
  for (const gap of gaps) {
    assert.ok(gap >= 9_900 && gap <= 15_000, `gap ${Math.round(gap)} ms`);
  }
  // A lock in the middle: sent, then confirmed by a follow-up read.
  await gladys.fake.devices.push(gladys.fake.discoveredDevices[0]);
  const ack = await within(
    gladys.fake.setValue({ external_id: did() }, { external_id: fid('lock') }, 1),
    3000,
    'lock',
  );
  assert.equal(ack.success, true);
  await waitFor(() => app.memory.pendingLock === null, { ms: 5000, what: 'confirmed' });
  app.stop();
  const requests = bridge.requests.length;
  await new Promise((resolve) => setTimeout(resolve, 2000 / SPEED + 300));
  assert.equal(bridge.requests.length, requests, 'no request after stop');
  assert.equal(clock.live, 0, 'no timer after stop');
  assert.ok(clock.set < 200, `timers set: ${clock.set}`);
});
