// -----------------------------------------------------------------------------
// States to Gladys within its 300 states a minute (250 kept): only changed
// values are sent; over the budget, the latest value of each feature waits
// (never dropped) and leaves as soon as the minute frees. A value observed a
// while ago carries its `created_at` (Gladys then neither fires a scene nor
// shows it as new); one older than 2 hours is never sent.
// -----------------------------------------------------------------------------

import { LIMITS, MINUTE, SECOND, TIMINGS } from './constants.js';

export class StatePublisher {
  constructor({ gladys, logger, now, monotonic, timers }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    /** featureExternalId -> JSON of the value last sent */
    this.sent = new Map();
    /** featureExternalId -> { value, at } waiting */
    this.pending = new Map();
    this.window = [];
    this.timer = undefined;
    this.running = false;
    this.flushing = undefined;
  }

  start() {
    this.running = true;
  }

  stop() {
    this.running = false;
    this.pending.clear();
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Forgets what was sent (Gladys restarted, a device was created): everything is sent again. */
  forget() {
    this.sent.clear();
  }

  /**
   * Queues values: `[{ id, value, at? }]`, `value` a number or `{ text }`,
   * `at` the wall time it was observed (default: now).
   */
  async publish(values, { force = false } = {}) {
    const now = this.now();
    for (const { id, value, at = now } of values) {
      if (now - at > TIMINGS.stateMaxAge) continue;
      const key = JSON.stringify(value);
      if (!force && this.sent.get(id) === key && !this.pending.has(id)) continue;
      this.pending.set(id, { value, at, key });
    }
    await this.flush();
  }

  async flush() {
    if (!this.running || this.flushing) {
      return this.flushing;
    }
    this.flushing = this.flushOnce().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  async flushOnce() {
    const mono = this.monotonic();
    this.window = this.window.filter((t) => mono - t < MINUTE);
    const room = LIMITS.statesPerMinute - this.window.length;
    const batch = [...this.pending.entries()].slice(0, Math.max(0, room));
    if (batch.length > 0) {
      const now = this.now();
      const states = [];
      for (const [id, { value, at, key }] of batch) {
        this.pending.delete(id);
        if (now - at > TIMINGS.stateMaxAge) continue;
        const state =
          typeof value === 'number'
            ? { device_feature_external_id: id, state: value }
            : { device_feature_external_id: id, text: value.text };
        if (now - at > 10 * SECOND) {
          state.created_at = new Date(at).toISOString();
        }
        states.push({ id, key, state });
        this.window.push(mono);
      }
      if (states.length > 0) {
        try {
          await this.gladys.publishStates(states.map((s) => s.state));
          for (const s of states) this.sent.set(s.id, s.key);
        } catch (err) {
          this.logger?.warn(`Publishing states failed: ${err.message}`);
        }
      }
    }
    if (this.pending.size > 0 && this.running && this.timer === undefined) {
      this.timer = this.timers.setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, SECOND);
    }
  }
}
