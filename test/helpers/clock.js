// -----------------------------------------------------------------------------
// A virtual clock for an app that takes `now`, `monotonic` and `timers` by
// injection (taken from gladys-testkit, same author): nothing fires by
// itself; every read moves the time by 1 µs (a decision reading the clock
// twice sees it move); `advance(ms)` fires the due timers in order, a turn of
// the event loop between two.
// -----------------------------------------------------------------------------

/** Lets pending promises and I/O callbacks run (a few turns of the event loop). */
export async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Waits (real time) until `check()` is truthy; rejects after `ms` real
 * milliseconds: a test fails, it never hangs.
 */
export async function waitFor(check, { ms = 3000, what = 'condition' } = {}) {
  const deadline = performance.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** A promise that rejects after `ms` real milliseconds unless `promise` settles first. */
export function within(promise, ms = 3000, what = 'promise') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${what}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * `ioMs`: real milliseconds given to the I/O (the fake bridge on the
 * loopback) after each timer fired, so a request started by a timer is
 * answered before the next timer (a stall timeout) fires.
 */
export function testClock({ start = Date.UTC(2026, 10, 5, 12), step = 0.001, ioMs = 4 } = {}) {
  let t = 0;
  let seq = 0;
  const pending = new Map();
  const read = () => (t += step);
  const add = (fn, ms, args) => {
    seq += 1;
    const h = { id: seq };
    pending.set(h, { fn, args, at: t + Math.max(0, Number(ms) || 0), seq });
    return h;
  };
  const clock = {
    now: () => start + read(),
    monotonic: () => read(),
    get elapsed() {
      return t;
    },
    get pending() {
      return pending.size;
    },
    timers: {
      setTimeout: (fn, ms, ...args) => add(fn, ms, args),
      clearTimeout: (h) => pending.delete(h),
    },
    /** Moves the time on WITHOUT firing the timers due (a busy or frozen event loop). */
    jump(ms) {
      t += ms;
    },
    /** Moves the wall clock alone (a clock set back or forward). */
    shiftWall(ms) {
      start += ms;
    },
    /**
     * `beforeFire`: awaited before each timer fires and at the end (e.g. "no
     * request in flight"), so real I/O never races the virtual time.
     */
    async advance(ms, { beforeFire } = {}) {
      const target = t + ms;
      for (let guard = 0; guard < 100_000; guard += 1) {
        // The I/O settles first: it may arm or clear timers.
        if (beforeFire) await beforeFire();
        let next;
        for (const [h, timer] of pending) {
          if (
            timer.at <= target &&
            (!next || timer.at < next[1].at || (timer.at === next[1].at && timer.seq < next[1].seq))
          ) {
            next = [h, timer];
          }
        }
        if (!next) break;
        const [h, timer] = next;
        t = Math.max(t, timer.at);
        pending.delete(h);
        timer.fn(...timer.args);
        await settle(2);
        if (ioMs > 0) await new Promise((resolve) => setTimeout(resolve, ioMs));
        await settle(2);
      }
      t = Math.max(t, target);
      await settle(2);
    },
  };
  return clock;
}
