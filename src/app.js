// -----------------------------------------------------------------------------
// The integration: the LOQED bridge read (GET /status) at the configured
// interval and told by its webhooks, the Gladys device and its states, the
// badges, and the commands of the lock under Louis's safety rules:
//
// LOCK (protective) is never held back: not by the options, a missing or
// failed read, the identity of the bridge, a pause asked by the bridge, a read
// in flight (cancelled), /data (never awaited on its path), nor an unlock in
// progress. It leaves at once, is tried again for 250 ms while no connection
// opens, then is kept in /data (`pendingLock`) and sent again by the reads
// until a read started after it shows the lock locked. Only a send the bridge
// answered 2xx counts as a try (3 at most); one that never left is never
// given up. A movement made afterwards with another key (app, keypad), seen
// by a signed webhook clearly later than the send, ends it.
//
// UNLOCK and OPEN (sensitive) are off unless allowed (`allow_unlock`;
// opening needs `allow_open` too), never a switch. Each one: one at a time;
// refused while a lock waits or the local key was refused; decided on a read
// started after the click (identity, lock online, still, not already there);
// its guard written to /data before the first byte (refused if that fails);
// last checks synchronously right before the bytes leave (option, no lock
// clicked since, 3.5 s after the click at most); never sent after a lock.
//
// A read started before a command (or a lock click) is never applied after
// it; reads apply in the order they started, never the order they answered.
// index.js only wires the SDK handlers to this class.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { BridgeError, ERROR_KINDS, bridgeRequest } from './bridge.js';
import { ChannelClient } from './channel.js';
import {
  TOKEN_KEYS,
  connectionKey,
  isToken,
  keyTag,
  normalizeConfig,
  normalizeIp,
} from './config.js';
import {
  ACTION_CODES,
  ENDPOINTS,
  FEATURES,
  LIMITS,
  POSITIONS,
  RECEIVER,
  TIMINGS,
  WEBHOOK_FLAGS,
} from './constants.js';
import { buildDevice, deviceIds, parseExternalId, positionValues } from './devices.js';
import { A, C, POSITION_TEXT, T, message, word } from './i18n.js';
import {
  addHookHeaders,
  deleteHookHeaders,
  hookBody,
  listHooksHeaders,
  parseEvent,
  parseStatus,
  signCommand,
  verifyWebhook,
} from './loqed.js';
import { StatePublisher } from './publisher.js';
import { bounded, emptyMemory, fileStore, normalizeMemory, serializeMemory } from './store.js';

/** A refusal shown in the ack of a command (Gladys shows the message). */
export class Refusal extends Error {
  constructor(entry, language) {
    super(word(entry, language));
    this.entry = entry;
  }
}

const newToken = () => randomBytes(24).toString('base64url');
const urlTag = (url) => createHash('sha256').update(url).digest('hex').slice(0, 8);

export class LoqedApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'loqed' }),
    store = fileStore(),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    request = bridgeRequest,
    createChannel = (options) => new ChannelClient(options),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.request = request;
    this.createChannel = createChannel;
    this.publisher = new StatePublisher({ gladys, logger, now, monotonic, timers });
    this.config = normalizeConfig();
    this.memory = emptyMemory();
    /** 'none' before the first load, 'ok', or 'unreadable' (never written then). */
    this.memoryState = 'none';
    this.tokens = { webhook: undefined, channel: undefined };
    this.generation = 0;
    this.started = false;
    this.stopped = false;
    /** key -> timer handle: one timer per flow. */
    this.timerHandles = new Map();
    /** Numbered in beforeSend of every command: a read started before it is void. */
    this.cmdSeq = 0;
    /** Incremented by every lock click: a sensitive command started before it never leaves. */
    this.lockEpoch = 0;
    /** AbortControllers of the reads in flight (a lock cancels them). */
    this.reads = new Set();
    this.readChain = undefined;
    this.readAgain = false;
    /** The start (monotonic) of the latest read or webhook applied. */
    this.appliedFrom = -Infinity;
    this.lockSending = undefined;
    this.lastLock = undefined;
    this.sensitiveBusy = false;
    this.lastSensitive = undefined;
    this.lastCommandMono = -Infinity;
    this.observed = { position: undefined, battery: undefined, online: undefined, at: 0 };
    this.lastCommandText = undefined;
    this.failures = 0;
    this.lastError = undefined;
    this.pauseUntilMono = -Infinity;
    this.receiver = { status: 'not started', port: null };
    this.lastReceiverEnv = undefined;
    this.lastReceiverTry = -Infinity;
    this.channel = undefined;
    this.hookState = 'off';
    this.hookUrl = undefined;
    this.replay = new Map();
    this.refusedWebhooks = 0;
    this.lastRefusedStatus = -Infinity;
    this.lastTest = -Infinity;
    this.adopt = undefined;
    this.lastStatus = undefined;
    this.transports = new Map();
    this.discovered = undefined;
    this.configRetry = 0;
    this.startedWall = Infinity;
    this.memoryRetry = undefined;
  }

  // --- Timers -------------------------------------------------------------------

  later(key, ms, fn) {
    this.cancel(key);
    if (this.stopped) return;
    const handle = this.timers.setTimeout(
      () => {
        this.timerHandles.delete(key);
        if (this.stopped) return;
        Promise.resolve()
          .then(fn)
          .catch((err) => this.logger.warn(`${key}: ${err.message}`));
      },
      Math.max(0, ms),
    );
    this.timerHandles.set(key, handle);
  }

  cancel(key) {
    const handle = this.timerHandles.get(key);
    if (handle !== undefined) {
      this.timers.clearTimeout(handle);
      this.timerHandles.delete(key);
    }
  }

  clearTimers() {
    for (const handle of this.timerHandles.values()) this.timers.clearTimeout(handle);
    this.timerHandles.clear();
  }

  // --- Lifecycle ----------------------------------------------------------------

  /** Connected to Gladys (first time or again): the configuration, retried without end. */
  async gladysConnected() {
    const generation = ++this.configRetry;
    for (let attempt = 0; ; attempt += 1) {
      let raw;
      try {
        raw = await this.gladys.getConfig();
      } catch (err) {
        if (generation !== this.configRetry || this.stopped) return;
        this.logger.warn(`Reading the configuration failed: ${err.message}`);
        await this.setStatus(false, T.configRetry).catch(() => {});
        const delays = TIMINGS.configRetry;
        await new Promise((resolve) =>
          this.later('config', delays[Math.min(attempt, delays.length - 1)], resolve),
        );
        if (generation !== this.configRetry || this.stopped) return;
        continue;
      }
      if (generation !== this.configRetry || this.stopped) return;
      if (!this.started) {
        await this.start(raw);
        return;
      }
      await this.configUpdated(raw);
      // Gladys may have given the receiver another port: registered again if so.
      this.ensureReceiver().catch(() => {});
      // Gladys keeps the status, the Discovery list and the badges in memory only.
      this.lastStatus = undefined;
      this.discovered = undefined;
      this.transports.clear();
      this.publisher.forget();
      await this.updateStatus();
      await this.publishDiscovery();
      await this.publishTransports();
      await this.republish();
      return;
    }
  }

  /**
   * Reads /data (bounded). A lock clicked before (or while) it is read is
   * never lost: it is merged with what /data holds (the latest click wins,
   * its count back to 0), written, and the caller sends it first.
   */
  async loadMemory() {
    try {
      const raw = await bounded(
        Promise.resolve().then(() => this.store.load()),
        TIMINGS.storeTimeout,
        this.timers,
      );
      // Read after the load: a click during it counts too.
      const clicked = this.memory.pendingLock;
      const loaded = normalizeMemory(raw, this.now());
      const before = this.memory;
      this.memory = loaded;
      // What this session learnt while /data could not be read stays.
      if (before.keyRefused && !loaded.keyRefused) loaded.keyRefused = before.keyRefused;
      if (this.memory.pendingLock || clicked) {
        const latest =
          clicked && (!loaded.pendingLock || clicked.at >= loaded.pendingLock.at) ? clicked : null;
        this.memory.pendingLock = latest
          ? { at: latest.at, sends: latest.sends ?? 0 }
          : this.memory.pendingLock;
      }
      this.memoryState = 'ok';
      if (clicked) this.kickSave();
      return true;
    } catch (err) {
      // Unreadable is not empty: no new identity, nothing written over it;
      // a lock clicked meanwhile is kept in memory.
      if (this.memoryState !== 'unreadable') {
        this.logger.warn(`/data/loqed.json cannot be read (${err.code ?? err.message})`);
      }
      this.memory = {
        ...emptyMemory(),
        pendingLock: this.memory.pendingLock,
        keyRefused: this.memory.keyRefused,
      };
      this.memoryState = 'unreadable';
      return false;
    }
  }

  /**
   * /data could not be read: read again (bounded, one at a time) at each
   * round. Once readable, a lock it holds leaves at once, the device is
   * published, the bridge read.
   */
  async retryMemory() {
    if (this.memoryState !== 'unreadable' || this.memoryRetry || this.stopped) return;
    const generation = this.generation;
    this.memoryRetry = this.loadMemory().finally(() => {
      this.memoryRetry = undefined;
    });
    const ok = await this.memoryRetry;
    if (!ok || generation !== this.generation) return;
    this.logger.info('/data/loqed.json is readable again');
    if (this.memory.pendingLock) {
      this.armPendingTick(TIMINGS.lockPendingRead);
      this.sendLock({ clicked: false }).catch(() => {});
    }
    await this.publishDiscovery();
    await this.updateStatus();
  }

  /** Writes /data (bounded); never awaited on the lock path. Rejects on failure. */
  saveMemory() {
    if (this.memoryState !== 'ok') {
      return Promise.reject(new Error('/data is not readable'));
    }
    return bounded(
      Promise.resolve().then(() => this.store.save(serializeMemory(this.memory))),
      TIMINGS.storeTimeout,
      this.timers,
    );
  }

  /** A save nobody waits for. */
  kickSave() {
    this.saveMemory().catch((err) => this.logger.warn(`Writing /data failed: ${err.message}`));
  }

  async start(raw = {}) {
    this.stop();
    this.stopped = false;
    this.started = true;
    const generation = this.generation;
    this.config = normalizeConfig(raw);
    // Seconds: the bridge dates its webhooks to the second.
    this.startedWall = Math.floor(this.now() / 1000) * 1000;
    if (this.memoryState !== 'ok') {
      await this.loadMemory();
      if (generation !== this.generation) return;
    }
    this.observed = { position: undefined, battery: undefined, online: undefined, at: 0 };
    this.failures = 0;
    this.lastError = undefined;
    this.appliedFrom = -Infinity;
    this.hookState = 'off';
    this.hookUrl = undefined;
    this.pauseUntilMono =
      this.memory.pausedUntil > this.now()
        ? this.monotonic() + (this.memory.pausedUntil - this.now())
        : -Infinity;
    this.liftKeyRefusalIfNewKey();
    if (this.memory.sensitive) {
      this.logger.warn('An unlock or open may have left just before the restart');
      this.setLastCommand(T.sensitiveAfterRestart);
      this.memory.sensitive = null;
      this.kickSave();
    }
    this.publisher.start();
    // A lock kept in /data leaves first, before any read.
    if (this.memory.pendingLock) {
      this.armPendingTick(0);
      this.sendLock({ clicked: false }).catch(() => {});
    }
    await this.ensureTokens(raw);
    if (generation !== this.generation) return;
    await this.updateStatus();
    if (this.config.problem) {
      return;
    }
    await this.publishDiscovery();
    this.ensureReceiver().catch(() => {});
    // Never a read faster than the interval, even across a restart.
    const interval = this.config.pollInterval * 1000;
    const wait = Math.min(interval, Math.max(0, this.memory.lastTry + interval - this.now()));
    this.later('poll', wait, () => this.poll());
  }

  /** A clean stop: everything stops, then /data is written once more (bounded). */
  async shutdown() {
    this.stop();
    if (this.memoryState === 'ok') {
      await this.saveMemory().catch((err) =>
        this.logger.warn(`Writing /data failed: ${err.message}`),
      );
    }
  }

  stop() {
    this.generation += 1;
    this.stopped = true;
    this.clearTimers();
    this.publisher.stop();
    for (const controller of this.reads) controller.abort();
    this.reads.clear();
    this.channel?.stop();
    this.channel = undefined;
  }

  /** A configuration saved: a new bridge address restarts; the rest applies at once. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    if (!this.started || connectionKey(next) !== connectionKey(this.config)) {
      await this.start(raw);
      return;
    }
    const before = this.config;
    this.config = next;
    await this.ensureTokens(raw);
    this.liftKeyRefusalIfNewKey();
    if (before.language !== next.language) {
      this.discovered = undefined;
      await this.publishDiscovery();
    }
    if (before.pollInterval !== next.pollInterval) {
      this.later('poll', next.pollInterval * 1000, () => this.poll());
    }
    if (
      JSON.stringify(this.receiverEnv()) !== this.lastReceiverEnv ||
      before.callbackHost !== next.callbackHost ||
      Boolean(before.bridgeKey) !== Boolean(next.bridgeKey) ||
      (before.bridgeKey && next.bridgeKey && !before.bridgeKey.equals(next.bridgeKey))
    ) {
      await this.ensureReceiver().catch(() => {});
    }
    // A lock waiting since a refusal of the key leaves first with the new key.
    if (this.memory.pendingLock && !this.memory.keyRefused && !this.lockSending) {
      this.sendLock({ clicked: false }).catch(() => {});
    }
    await this.updateStatus();
  }

  /** The refusal of the local key ends when another key (or key id) is saved. */
  liftKeyRefusalIfNewKey() {
    const refused = this.memory.keyRefused;
    if (!refused || !this.config.localKey) return;
    if (refused.salt && refused.tag !== null && keyTag(refused.salt, this.config) === refused.tag) {
      return;
    }
    this.memory.keyRefused = null;
    this.logger.info('New local key: commands go again');
    this.kickSave();
  }

  /** The secrets of the receiver: generated once, kept in the Gladys configuration. */
  async ensureTokens(raw) {
    const missing = {};
    for (const [name, key] of Object.entries(TOKEN_KEYS)) {
      const value = raw?.[key];
      if (isToken(value)) {
        this.tokens[name] = value;
      } else {
        if (!isToken(this.tokens[name])) this.tokens[name] = newToken();
        missing[key] = this.tokens[name];
      }
    }
    if (Object.keys(missing).length > 0) {
      await this.gladys
        .setConfig(missing)
        .catch((err) => this.logger.warn(`Keeping the receiver secrets failed: ${err.message}`));
    }
  }

  // --- Status, badges, discovery -------------------------------------------------

  async setStatus(connected, entry) {
    const key = JSON.stringify([connected, entry ?? null]);
    if (key === this.lastStatus) return;
    await this.gladys.setConnectionStatus(connected, entry);
    this.lastStatus = key;
  }

  /** Where a waiting lock stands, exactly; undefined when none waits. */
  lockNote() {
    if (!this.memory.pendingLock) return undefined;
    if (this.memory.keyRefused) return T.lockKeyRefused;
    const result = this.lastLock?.result;
    if (result === 'noConfig' || this.config.commandProblem || this.config.problem) {
      return T.lockNoConfig;
    }
    if (result === undefined || result === 'notSent') return T.lockNotLeft;
    if (result === 'sending') return T.lockSending;
    return T.lockPending;
  }

  statusEntry() {
    const [connected, entry] = this.baseStatus();
    const note = this.lockNote();
    if (!note || connected) return [connected, entry];
    return [connected, { en: `${entry.en} ${note.en}`, fr: `${entry.fr} ${note.fr}` }];
  }

  baseStatus() {
    const c = this.config;
    if (c.problem) return [false, T[c.problem]];
    if (this.memoryState === 'unreadable') return [false, T.dataUnreadable];
    if (this.memory.mac && this.memory.otherMac) return [false, T.otherBridge];
    if (this.memory.keyRefused) return [false, T.keyRefused];
    if (this.lastError === 'bad_response') return [false, T.badAnswer];
    if (this.failures > 0 && this.monotonic() < this.pauseUntilMono) return [false, T.paused];
    if (this.failures > 0 || !this.memory.mac) {
      return [false, this.failures > 0 ? T.unreachable : T.connecting];
    }
    const notes = [];
    const lock = this.lockNote();
    if (lock) notes.push(lock);
    if (this.observed.online === false) notes.push(T.lockOffline);
    if (c.commandProblem) notes.push(T[c.commandProblem]);
    if (c.hookProblem) notes.push(T[c.hookProblem]);
    else if (this.hookState === 'refused') notes.push(T.hookRefused);
    else if (this.hookState === 'failed') notes.push(T.hookFailed);
    else if (this.receiver.status !== 'running') notes.push(T.receiverDown);
    if (this.refusedWebhooks > 0) notes.push(T.webhookRefused);
    const hooks = this.hookState === 'ok' ? T.webhooksOn : T.webhooksOff;
    return [
      true,
      {
        en: [`${T.connected.en} (${hooks.en})`, ...notes.map((n) => n.en)].join('. '),
        fr: [`${T.connected.fr} (${hooks.fr})`, ...notes.map((n) => n.fr)].join('. '),
      },
    ];
  }

  async updateStatus() {
    if (this.stopped) return;
    const [connected, entry] = this.statusEntry();
    await this.setStatus(connected, entry).catch((err) =>
      this.logger.warn(`Status not sent: ${err.message}`),
    );
  }

  /** The identity of the bridge in use; undefined while unknown or contested. */
  trustedMac() {
    return this.memory.mac && !this.memory.otherMac ? this.memory.mac : undefined;
  }

  async publishDiscovery() {
    const mac = this.trustedMac();
    if (!mac || this.stopped) return;
    const device = buildDevice(this.gladys, mac, {
      language: this.config.language,
      host: this.config.host,
    });
    const key = JSON.stringify(device);
    if (key === this.discovered) return;
    try {
      await this.gladys.publishDiscoveredDevices([device]);
      this.discovered = key;
    } catch (err) {
      this.logger.warn(`Discovery not published: ${err.message}`);
    }
  }

  async publishTransports() {
    const mac = this.trustedMac();
    if (!mac || this.stopped) return;
    const reachable = this.failures === 0;
    const badge = {
      external_id: deviceIds(this.gladys, mac).device,
      transport: reachable ? 'local' : 'unreachable',
      ...(reachable && this.observed.online === false
        ? { degraded: true, message: T.lockOffline }
        : {}),
    };
    const key = JSON.stringify(badge);
    if (this.transports.get(mac) === key) return;
    try {
      await this.gladys.publishTransports([badge]);
      this.transports.set(mac, key);
    } catch (err) {
      this.logger.warn(`Badge not published: ${err.message}`);
    }
  }

  /** Values of the trusted lock, observed at `at` (wall). */
  async publishValues(values, at = this.now()) {
    const mac = this.trustedMac();
    if (!mac || this.stopped || values.length === 0) return;
    const ids = deviceIds(this.gladys, mac);
    await this.publisher.publish(
      values.map(({ key, value }) => ({ id: ids.feature(key), value, at })),
    );
  }

  setLastCommand(entry) {
    this.lastCommandText = { entry, at: this.now() };
    this.publishValues(
      [{ key: FEATURES.LAST_COMMAND, value: { text: word(entry, this.config.language) } }],
      this.lastCommandText.at,
    ).catch(() => {});
  }

  /** Everything known again (Gladys restarted, the device was created), with its own date. */
  async republish() {
    const o = this.observed;
    if (!o.at) return;
    const values = [];
    if (o.position) values.push(...positionValues(o.position, this.config.language));
    if (o.battery !== undefined) values.push({ key: FEATURES.BATTERY, value: o.battery });
    await this.publishValues(values, o.at);
    if (this.lastCommandText) {
      await this.publishValues(
        [
          {
            key: FEATURES.LAST_COMMAND,
            value: { text: word(this.lastCommandText.entry, this.config.language) },
          },
        ],
        this.lastCommandText.at,
      );
    }
  }

  async scan() {
    await this.publishDiscovery();
    if (!this.trustedMac() && !this.config.problem) {
      // Never faster than the interval: the scheduled read finds the bridge.
      const interval = this.config.pollInterval * 1000;
      if (this.now() - this.memory.lastTry >= interval) await this.poll();
    }
  }

  async deviceCreated(device) {
    const parsed = parseExternalId(this.gladys, device?.external_id);
    if (!parsed || parsed.mac !== this.trustedMac()) return;
    this.publisher.forget();
    await this.republish();
    await this.publishTransports();
  }

  // --- Reads -----------------------------------------------------------------------

  paused() {
    return this.monotonic() < this.pauseUntilMono;
  }

  /** The scheduled read, then the next one. */
  async poll() {
    if (this.stopped) return;
    const interval = this.config.pollInterval * 1000;
    await this.retryMemory();
    if (this.stopped) return;
    try {
      if (!this.paused()) {
        await this.read();
      }
    } finally {
      if (!this.stopped) {
        let next = interval;
        if (this.failures > 0) {
          const steps = TIMINGS.backoff;
          next = Math.min(
            interval * 10,
            Math.max(interval, steps[Math.min(this.failures, steps.length) - 1]),
          );
        }
        if (this.paused()) next = Math.max(next, this.pauseUntilMono - this.monotonic());
        this.later('poll', next, () => this.poll());
      }
    }
  }

  /** One read at a time; a read asked during one runs right after it. */
  read() {
    // A pause asked by the bridge holds every read but those of a waiting lock.
    if (this.paused() && !this.memory.pendingLock) return Promise.resolve();
    if (this.readChain) {
      this.readAgain = true;
      return this.readChain;
    }
    this.readChain = (async () => {
      try {
        do {
          this.readAgain = false;
          await this.readOnce();
        } while (this.readAgain && !this.stopped);
      } finally {
        this.readChain = undefined;
      }
    })();
    return this.readChain;
  }

  /**
   * GET /status. Resolves the parsed status, or undefined (failed, void, or
   * started before a command and so not applicable). `deadline` (monotonic)
   * bounds a decision read.
   */
  async readOnce({ deadline } = {}) {
    if (this.stopped || this.config.problem) return undefined;
    const generation = this.generation;
    const seq = this.cmdSeq;
    const epoch = this.lockEpoch;
    const startedAt = this.monotonic();
    if (this.memoryState === 'ok') {
      // The time of the attempt goes to /data first (never awaited).
      this.memory.lastTry = this.now();
      this.kickSave();
    }
    const controller = new AbortController();
    this.reads.add(controller);
    let answer;
    try {
      answer = await this.request({
        host: this.config.host,
        port: this.config.port,
        method: 'GET',
        path: ENDPOINTS.STATUS,
        timeout:
          deadline === undefined
            ? TIMINGS.readTimeout
            : Math.max(1, Math.min(TIMINGS.readTimeout, deadline - startedAt)),
        stallMs: TIMINGS.stallTimeout,
        signal: controller.signal,
        json: true,
        timers: this.timers,
      });
    } catch (err) {
      if (generation !== this.generation) return undefined;
      if (err.kind === ERROR_KINDS.ABORTED) return undefined; // a lock cut it: not a failure
      await this.readFailed(err);
      return undefined;
    } finally {
      this.reads.delete(controller);
    }
    if (generation !== this.generation) return undefined;
    const status = parseStatus(answer.json);
    if (!status) {
      await this.readFailed(new BridgeError(ERROR_KINDS.BAD_RESPONSE, 'Not a bridge'));
      return undefined;
    }
    this.failures = 0;
    this.lastError = undefined;
    // A command left (or a lock was clicked) while this read was out: it may
    // show the lock before that command. Never applied; another read follows.
    if (this.cmdSeq !== seq || this.lockEpoch !== epoch || startedAt < this.appliedFrom) {
      this.readAgain = this.readAgain || this.cmdSeq !== seq || this.lockEpoch !== epoch;
      return undefined;
    }
    await this.applyStatus(status, startedAt);
    return status;
  }

  async readFailed(err) {
    this.failures += 1;
    this.lastError = err.kind;
    if (err.kind === ERROR_KINDS.HTTP && (err.status === 429 || err.status >= 500)) {
      const seconds = err.retryAfter ?? 60 * 2 ** Math.min(this.failures - 1, 8);
      const ms = Math.min(TIMINGS.pauseMax, Math.max(TIMINGS.pauseMin, seconds * 1000));
      this.pauseUntilMono = this.monotonic() + ms;
      if (this.memoryState === 'ok') {
        this.memory.pausedUntil = this.now() + ms;
        this.kickSave();
      }
    }
    this.logger.debug?.(`Bridge read failed: ${err.message}`);
    await this.publishTransports();
    await this.updateStatus();
  }

  async applyStatus(status, startedAt) {
    this.appliedFrom = startedAt;
    if (this.memoryState === 'ok' && this.memory.pausedUntil) {
      this.memory.pausedUntil = 0;
      this.pauseUntilMono = -Infinity;
    }
    if (!this.memory.mac) {
      if (this.memoryState !== 'ok') {
        await this.updateStatus();
        return;
      }
      // The first bridge read at this address keys the device, once in /data.
      this.memory.mac = status.mac;
      try {
        await this.saveMemory();
      } catch {
        this.memory.mac = null;
        await this.updateStatus();
        return;
      }
      this.logger.info(`Bridge ${status.mac} found`);
      await this.publishDiscovery();
    } else if (status.mac !== this.memory.mac) {
      if (this.memory.otherMac !== status.mac) {
        this.memory.otherMac = status.mac;
        this.kickSave();
        this.logger.warn(`Another bridge (${status.mac}) answers at the address`);
      }
      await this.updateStatus();
      return;
    } else if (this.memory.otherMac) {
      // The right bridge answers again.
      this.memory.otherMac = null;
      this.kickSave();
    }
    this.observed = {
      position: status.position,
      battery: status.battery ?? this.observed.battery,
      online: status.online,
      at: this.now(),
    };
    const values = positionValues(status.position, this.config.language);
    if (status.battery !== undefined) {
      values.push({ key: FEATURES.BATTERY, value: status.battery });
    }
    await this.publishValues(values);
    this.confirmCommands(status.position, startedAt);
    await this.publishTransports();
    await this.updateStatus();
  }

  /** A read started after the commands: confirms them, or sends a waiting lock again. */
  confirmCommands(position, startedAt) {
    const s = this.lastSensitive;
    if (s && !s.confirmed && startedAt >= s.mono) {
      const expected =
        s.action === 'open' ? [POSITIONS.OPEN] : [POSITIONS.UNLOCKED, POSITIONS.OPEN];
      if (expected.includes(position)) {
        s.confirmed = true;
        this.setLastCommand(s.action === 'open' ? C.openConfirmed : C.unlockConfirmed);
      }
    }
    const pending = this.memory.pendingLock;
    if (!pending) return;
    if (position === POSITIONS.LOCKED) {
      this.memory.pendingLock = null;
      this.cancel('pending');
      this.kickSave();
      this.setLastCommand(C.lockConfirmed);
      return;
    }
    const last = this.lastLock;
    const sinceSend = last ? this.monotonic() - last.mono : Infinity;
    if (sinceSend < TIMINGS.lockResendAfter || this.lockSending) return;
    if (pending.sends >= LIMITS.lockSends) {
      this.memory.pendingLock = null;
      this.cancel('pending');
      this.kickSave();
      this.setLastCommand(T.lockGivenUp);
      this.logger.warn('Lock sent 3 times without the lock reporting it locked');
      return;
    }
    if (!this.memory.keyRefused) {
      this.sendLock({ clicked: false }).catch(() => {});
    }
  }

  // --- Commands ---------------------------------------------------------------------

  async setValue(device, feature, value) {
    const parsed = parseExternalId(this.gladys, feature?.external_id);
    const language = this.config.language;
    if (!parsed?.key || ![FEATURES.LOCK, FEATURES.UNLOCK, FEATURES.OPEN].includes(parsed.key)) {
      throw new Refusal(C.unknownFeature, language);
    }
    if (Number(value) !== 1) {
      throw new Refusal(C.badValue, language);
    }
    if (parsed.key === FEATURES.LOCK) {
      return this.lockClicked();
    }
    return this.sensitive(parsed.key === FEATURES.OPEN ? 'open' : 'unlock', parsed.mac);
  }

  /** LOCK: never held back (see the header). */
  async lockClicked() {
    const language = this.config.language;
    this.lockEpoch += 1;
    // Reads in flight could show the lock before it: cancelled (not a failure).
    for (const controller of this.reads) controller.abort();
    this.memory.pendingLock = { at: this.now(), sends: 0 };
    this.armPendingTick(TIMINGS.lockPendingRead);
    if (this.memoryState === 'ok') this.kickSave();
    const result = await this.sendLock({ clicked: true });
    const entry = {
      sent: C.lockSent,
      notSent: C.lockNotSent,
      noConfig: C.lockNoConfig,
      keyRefused: C.lockKeyRefused,
      error: C.lockError,
      noAnswer: C.lockNoAnswer,
    }[result];
    if (result === 'sent') {
      return word(entry, language);
    }
    throw new Refusal(entry, language);
  }

  /** While a lock waits: read (which sends it again if needed), or send it if it never left. */
  armPendingTick(ms) {
    this.later('pending', ms, async () => {
      await this.retryMemory();
      if (!this.memory.pendingLock) return;
      this.armPendingTick(TIMINGS.lockPendingRead);
      const last = this.lastLock?.result;
      if (
        (last === undefined || last === 'notSent' || last === 'noConfig') &&
        !this.memory.keyRefused
      ) {
        await this.sendLock({ clicked: false });
      } else {
        await this.read();
      }
    });
  }

  /** Arms the reads that follow a command (before anything is saved). */
  armFollowUps() {
    TIMINGS.followUps.forEach((ms, i) => this.later(`follow${i}`, ms, () => this.read()));
  }

  /**
   * Sends the waiting lock. Resolves 'sent' (answered 2xx: counted), 'noAnswer'
   * (left, no answer), 'error' (answered an error), 'keyRefused' (401/403),
   * 'notSent' (no connection within the budget) or 'noConfig'.
   */
  sendLock({ clicked }) {
    if (this.lockSending) return this.lockSending;
    this.lockSending = this.sendLockOnce({ clicked }).finally(() => {
      this.lockSending = undefined;
    });
    return this.lockSending;
  }

  async sendLockOnce({ clicked }) {
    const c = this.config;
    const done = (result) => {
      this.lastLock = { ...(this.lastLock ?? {}), result };
      return result;
    };
    if (!this.memory.pendingLock) return 'sent';
    if (!c.host || c.commandProblem) {
      this.setLastCommand(C.lockNoConfig);
      return done('noConfig');
    }
    if (this.memory.keyRefused && !clicked) return done('keyRefused');
    const generation = this.generation;
    const budgetEnd = this.monotonic() + TIMINGS.lockBudget;
    for (;;) {
      let sentMono;
      try {
        await this.request({
          host: c.host,
          port: c.port,
          method: 'GET',
          path: `${ENDPOINTS.TO_LOCK}?command_signed_base64=${signCommand(
            ACTION_CODES.LOCK,
            c.keyId,
            c.localKey,
            this.now() / 1000,
          )}`,
          timeout: TIMINGS.commandTimeout,
          timers: this.timers,
          beforeSend: () => {
            this.cmdSeq += 1;
            sentMono = this.monotonic();
            this.lastCommandMono = sentMono;
            this.lastLock = { mono: sentMono, wall: this.now(), result: 'sending' };
          },
        });
      } catch (err) {
        if (generation !== this.generation) return 'notSent';
        if (err.notSent) {
          if (this.monotonic() + TIMINGS.lockRetryGap < budgetEnd) {
            await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.lockRetryGap));
            if (generation !== this.generation) return 'notSent';
            continue;
          }
          this.setLastCommand(C.lockNotSent);
          return done('notSent');
        }
        this.armFollowUps();
        if (err.kind === ERROR_KINDS.HTTP && (err.status === 401 || err.status === 403)) {
          this.refuseKey();
          this.setLastCommand(C.lockKeyRefused);
          return done('keyRefused');
        }
        if (err.kind === ERROR_KINDS.HTTP) {
          this.setLastCommand(C.lockError);
          return done('error');
        }
        this.setLastCommand(C.lockNoAnswer);
        return done('noAnswer');
      }
      if (generation !== this.generation) return 'sent';
      // Answered 2xx: one try counted. The follow-up reads are armed before any save.
      this.armFollowUps();
      if (this.memory.pendingLock) {
        this.memory.pendingLock.sends = Math.min(
          LIMITS.lockSends,
          this.memory.pendingLock.sends + 1,
        );
      }
      if (this.memory.keyRefused) this.memory.keyRefused = null;
      if (this.memoryState === 'ok') this.kickSave();
      this.setLastCommand(C.lockSent);
      this.updateStatus().catch(() => {});
      return done('sent');
    }
  }

  refuseKey() {
    const salt = randomBytes(16).toString('hex');
    this.memory.keyRefused = { salt, tag: keyTag(salt, this.config) };
    if (this.memoryState === 'ok') this.kickSave();
    this.updateStatus().catch(() => {});
  }

  optionAllows(action) {
    return action === 'open'
      ? this.config.allowUnlock && this.config.allowOpen
      : this.config.allowUnlock;
  }

  /** UNLOCK or OPEN: off unless allowed, decided on a fresh read, guarded in /data. */
  async sensitive(action, mac) {
    const arrival = this.monotonic();
    const language = this.config.language;
    const refuse = (entry) => {
      this.setLastCommand(entry);
      return new Refusal(entry, language);
    };
    if (!this.optionAllows(action)) {
      throw refuse(action === 'open' ? C.openOff : C.unlockOff);
    }
    if (this.sensitiveBusy) {
      throw refuse(C.refusedBusy);
    }
    this.sensitiveBusy = true;
    try {
      return await this.sensitiveOnce(action, mac, arrival, refuse);
    } finally {
      this.sensitiveBusy = false;
    }
  }

  async sensitiveOnce(action, mac, arrival, refuse) {
    const c = this.config;
    const generation = this.generation;
    if (c.problem || c.commandProblem) throw refuse(C.refusedNoCommand);
    if (this.memoryState !== 'ok') throw refuse(C.refusedData);
    if (this.memory.keyRefused) throw refuse(C.refusedKey);
    const paused = this.pauseMessage(C.refusedPaused);
    if (paused) throw refuse(paused);
    if (this.memory.pendingLock || this.lockSending) throw refuse(C.refusedPending);
    if (!this.trustedMac() || mac !== this.trustedMac()) throw refuse(C.refusedIdentity);
    const epoch = this.lockEpoch;
    const lockSince = () => epoch !== this.lockEpoch || this.memory.pendingLock || this.lockSending;
    // The decision read: started after the click, never a state in memory.
    const status = await this.readOnce({ deadline: arrival + TIMINGS.commandReadBy });
    if (generation !== this.generation) throw refuse(C.refusedLate);
    if (lockSince()) throw refuse(C.refusedLockedAfter);
    if (!status) throw refuse(C.refusedRead);
    if (status.mac !== this.trustedMac() || status.mac !== mac) throw refuse(C.refusedIdentity);
    if (status.online !== true) throw refuse(C.refusedOffline);
    const position = status.position;
    if (![POSITIONS.LOCKED, POSITIONS.UNLOCKED, POSITIONS.OPEN].includes(position)) {
      throw refuse(C.refusedState);
    }
    if (action === 'unlock' && position !== POSITIONS.LOCKED) {
      this.setLastCommand(C.alreadyUnlocked);
      return word(C.alreadyUnlocked, this.config.language);
    }
    // The guard goes to /data before the first byte; refused if it cannot.
    this.memory.sensitive = { action, at: this.now() };
    try {
      await bounded(
        this.saveMemory(),
        Math.max(1, arrival + TIMINGS.commandSaveBy - this.monotonic()),
        this.timers,
      );
    } catch {
      this.memory.sensitive = null;
      throw refuse(C.refusedData);
    }
    const clearGuard = () => {
      this.memory.sensitive = null;
      if (this.memoryState === 'ok') this.kickSave();
    };
    if (generation !== this.generation || this.monotonic() > arrival + TIMINGS.commandSendBy) {
      clearGuard();
      throw refuse(C.refusedLate);
    }
    let lastCheck;
    try {
      await this.request({
        host: c.host,
        port: c.port,
        method: 'GET',
        path: `${ENDPOINTS.TO_LOCK}?command_signed_base64=${signCommand(
          action === 'open' ? ACTION_CODES.OPEN : ACTION_CODES.UNLOCK,
          c.keyId,
          c.localKey,
          this.now() / 1000,
        )}`,
        // The answer by 4.6 s after the click: Gladys acks at 5 s.
        timeout: Math.max(
          1,
          Math.min(
            TIMINGS.commandTimeout,
            arrival + TIMINGS.commandSendBy + 1_100 - this.monotonic(),
          ),
        ),
        timers: this.timers,
        beforeSend: () => {
          // The last checks, synchronous, right before the first byte.
          lastCheck = undefined;
          if (!this.optionAllows(action)) lastCheck = action === 'open' ? C.openOff : C.unlockOff;
          else if (lockSince()) lastCheck = C.refusedLockedAfter;
          else if (this.memory.keyRefused) lastCheck = C.refusedKey;
          else if (this.monotonic() > arrival + TIMINGS.commandSendBy) lastCheck = C.refusedLate;
          else if (generation !== this.generation) lastCheck = C.refusedLate;
          if (lastCheck) throw new Error('refused');
          this.cmdSeq += 1;
          this.lastCommandMono = this.monotonic();
          this.lastSensitive = { action, mono: this.lastCommandMono, confirmed: false };
        },
      });
    } catch (err) {
      clearGuard();
      if (err.notSent) {
        throw refuse(lastCheck ?? C.refusedNotSent);
      }
      this.armFollowUps();
      if (err.kind === ERROR_KINDS.HTTP && (err.status === 401 || err.status === 403)) {
        this.refuseKey();
        throw refuse(C.refusedKey);
      }
      throw refuse(err.kind === ERROR_KINDS.HTTP ? C.sentError : C.sentNoAnswer);
    }
    this.armFollowUps();
    clearGuard();
    const entry = action === 'open' ? C.openSent : C.unlockSent;
    this.setLastCommand(entry);
    return word(entry, this.config.language);
  }

  // --- Receiver and webhooks ----------------------------------------------------------

  receiverEnv() {
    return {
      WEBHOOK_TOKEN: this.tokens.webhook,
      CHANNEL_TOKEN: this.tokens.channel,
      HTTP_PORT: String(RECEIVER.httpPort),
      CHANNEL_PORT: String(RECEIVER.channelPort),
      ...(this.config.checkSource && this.config.host ? { DEVICE_ADDRESS: this.config.host } : {}),
    };
  }

  /** Starts the receiver (Gladys recreates it when its env changed), then registers the webhook. */
  async ensureReceiver() {
    if (this.stopped || this.config.problem || this.config.hookProblem) {
      this.hookState = 'off';
      return;
    }
    this.lastReceiverTry = this.monotonic();
    const generation = this.generation;
    try {
      const env = this.receiverEnv();
      await this.gladys.startContainer(RECEIVER.name, { env });
      this.lastReceiverEnv = JSON.stringify(env);
      const containers = await this.gladys.getContainers();
      if (generation !== this.generation) return;
      const container = (containers ?? []).find((x) => x?.name === RECEIVER.name);
      const port = container?.ports?.find((p) => p?.name === RECEIVER.httpPortName)?.host_port;
      this.receiver = {
        status: typeof container?.status === 'string' ? container.status.slice(0, 40) : 'unknown',
        port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
      };
    } catch (err) {
      if (generation !== this.generation) return;
      this.receiver = { status: 'error', port: null };
      this.logger.warn(`Could not start the webhook receiver: ${err.message}`);
    }
    if (this.receiver.status === 'running' && this.receiver.port) {
      this.startChannel();
      await this.ensureHook();
    } else {
      this.later('receiver', TIMINGS.receiverRetry, () => this.ensureReceiver());
    }
    await this.updateStatus();
  }

  startChannel() {
    if (this.channel) return;
    const generation = this.generation;
    const channel = this.createChannel({
      host: RECEIVER.name,
      port: RECEIVER.channelPort,
      token: this.tokens.channel,
      logger: this.logger,
    });
    this.channel = channel;
    channel.on('message', (msg) => {
      if (generation !== this.generation) return;
      this.onWebhook(msg).catch((err) => this.logger.warn(`Webhook: ${err.message}`));
    });
    channel.start();
  }

  hookAddress() {
    const host = this.config.callbackHost;
    if (!host || !this.receiver.port || !isToken(this.tokens.webhook)) return undefined;
    const shown = host.includes(':') ? `[${host}]` : host;
    return `http://${shown}:${this.receiver.port}${RECEIVER.pathPrefix}${this.tokens.webhook}`;
  }

  /** The webhook at the bridge: listed, registered when missing, our old ones withdrawn. Secondary. */
  async ensureHook() {
    const c = this.config;
    const url = this.hookAddress();
    if (!url || !c.bridgeKey || c.problem) {
      this.hookState = 'off';
      return;
    }
    const generation = this.generation;
    const call = (method, path, headers, body) =>
      this.request({
        host: c.host,
        port: c.port,
        method,
        path,
        headers,
        body,
        timeout: TIMINGS.hookTimeout,
        json: method === 'GET',
        timers: this.timers,
      });
    try {
      const listed = await call(
        'GET',
        ENDPOINTS.WEBHOOKS,
        listHooksHeaders(c.bridgeKey, this.now() / 1000),
      );
      if (generation !== this.generation) return;
      const hooks = (Array.isArray(listed.json) ? listed.json : [])
        .slice(0, LIMITS.webhooksListed)
        .filter((h) => typeof h?.url === 'string' && Number.isInteger(h?.id) && h.id >= 0);
      if (!hooks.some((h) => h.url === url)) {
        await call(
          'POST',
          ENDPOINTS.WEBHOOKS,
          addHookHeaders(c.bridgeKey, this.now() / 1000, url, WEBHOOK_FLAGS),
          hookBody(url, WEBHOOK_FLAGS),
        );
      }
      if (generation !== this.generation) return;
      const tag = urlTag(url);
      const kept = [];
      for (const hook of hooks) {
        const old = urlTag(hook.url);
        if (hook.url !== url && this.memory.hooks.includes(old)) {
          try {
            await call(
              'DELETE',
              `${ENDPOINTS.WEBHOOKS}/${hook.id}`,
              deleteHookHeaders(c.bridgeKey, this.now() / 1000, hook.id),
            );
          } catch {
            kept.push(old);
          }
        }
      }
      if (generation !== this.generation) return;
      if (this.memoryState === 'ok') {
        this.memory.hooks = [...new Set([...kept, tag])].slice(-8);
        this.kickSave();
      }
      this.hookUrl = url;
      this.hookState = 'ok';
      this.later('hook', TIMINGS.hookCheck, () => this.ensureHook());
    } catch (err) {
      if (generation !== this.generation) return;
      this.hookState =
        err.kind === ERROR_KINDS.HTTP && (err.status === 401 || err.status === 403)
          ? 'refused'
          : 'failed';
      this.later('hook', TIMINGS.hookCheck / 6, () => this.ensureHook());
    }
    await this.updateStatus();
  }

  async noteRefusedWebhook(reason) {
    this.refusedWebhooks += 1;
    this.logger.debug?.(`Webhook refused (${reason})`);
    const mono = this.monotonic();
    if (mono - this.lastRefusedStatus >= TIMINGS.refusedStatusEvery) {
      this.lastRefusedStatus = mono;
      await this.updateStatus();
    }
  }

  /** A message of the receiver: a webhook of the bridge, checked here (signature, time, sender). */
  async onWebhook(msg) {
    if (this.stopped) return;
    if (msg?.type === 'refused') {
      await this.noteRefusedWebhook('sender');
      return;
    }
    if (msg?.type !== 'webhook') return;
    const c = this.config;
    if (!c.bridgeKey) return this.noteRefusedWebhook('no key');
    if (c.checkSource && normalizeIp(String(msg.from ?? '')) !== c.host) {
      return this.noteRefusedWebhook('sender');
    }
    const at = typeof msg.at === 'string' ? Date.parse(msg.at) : NaN;
    if (!Number.isFinite(at)) return this.noteRefusedWebhook('time');
    if (typeof msg.body !== 'string' || msg.body.length > LIMITS.webhookBytes * 2) {
      return this.noteRefusedWebhook('body');
    }
    const body = Buffer.from(msg.body, 'base64');
    if (body.length > LIMITS.webhookBytes) return this.noteRefusedWebhook('body');
    const verified = verifyWebhook(
      { body, timestamp: String(msg.timestamp ?? ''), hash: String(msg.hash ?? '') },
      c.bridgeKey,
    );
    if (!verified.ok) return this.noteRefusedWebhook(verified.reason);
    // The bridge time within the skew of the receiver time, and kept fresh.
    if (Math.abs(verified.seconds * 1000 - at) > TIMINGS.webhookSkew) {
      return this.noteRefusedWebhook('time');
    }
    const wall = this.now();
    if (wall - at > TIMINGS.webhookFresh || at - wall > TIMINGS.webhookSkew) {
      return undefined; // kept too long by the receiver: a read tells better
    }
    const mono = this.monotonic();
    for (const [hash, seen] of this.replay) {
      if (mono - seen > 2 * TIMINGS.webhookSkew + TIMINGS.webhookFresh) this.replay.delete(hash);
    }
    const hash = String(msg.hash).toLowerCase();
    if (this.replay.has(hash)) return this.noteRefusedWebhook('replay');
    if (this.replay.size >= LIMITS.replayCache) {
      this.replay.delete(this.replay.keys().next().value);
    }
    this.replay.set(hash, mono);
    let json;
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      return this.noteRefusedWebhook('json');
    }
    const event = parseEvent(json);
    if (!event) return undefined;
    const mac = this.trustedMac();
    if (event.mac && mac && event.mac !== mac) return this.noteRefusedWebhook('bridge');
    this.lastWebhookMono = mono;
    // Dated before this start: the replay cache did not exist then (a webhook
    // captured and sent again after a restart). Only a read decides.
    if (verified.seconds * 1000 < this.startedWall) {
      await this.read();
      return undefined;
    }
    await this.applyEvent(event, { at, seconds: verified.seconds, mono });
    return undefined;
  }

  async applyEvent(event, { at, seconds, mono }) {
    const mac = this.trustedMac();
    if (!mac) {
      await this.read();
      return;
    }
    if (event.kind === 'battery') {
      if (event.battery === undefined) {
        this.observed.online = false;
      } else {
        this.observed.battery = event.battery;
        this.observed.online = true;
        await this.publishValues([{ key: FEATURES.BATTERY, value: event.battery }], at);
      }
      await this.publishTransports();
      await this.updateStatus();
      return;
    }
    if (event.kind === 'online') {
      if (event.online !== undefined) this.observed.online = event.online;
      await this.publishTransports();
      await this.updateStatus();
      return;
    }
    this.overriddenLock(event, { at, seconds });
    const inWindow =
      this.memory.pendingLock ||
      this.lockSending ||
      this.sensitiveBusy ||
      mono - this.lastCommandMono < TIMINGS.commandWindow;
    if (event.kind === 'unclear' || inWindow) {
      // Around a command, only a read started now decides.
      await this.read();
      return;
    }
    const position = event.kind === 'moving' ? POSITIONS.MOVING : event.position;
    // Newer than any read in flight: those are not applied after it.
    this.appliedFrom = mono;
    this.observed = { ...this.observed, position, online: true, at };
    await this.publishValues(positionValues(position, this.config.language), at);
    if (event.kind === 'moving') {
      // The end of the movement comes by webhook; a read makes sure.
      this.later('afterMove', TIMINGS.followUps[2], () => this.read());
    }
  }

  /**
   * A waiting lock ends when the bridge reports a movement made afterwards
   * with another key: the app or the keypad, not this module. "Afterwards"
   * only with a clear margin on both clocks; in doubt the lock goes again.
   */
  overriddenLock(event, { at, seconds }) {
    const last = this.lastLock;
    if (
      !this.memory.pendingLock ||
      !last?.wall ||
      event.keyId === undefined ||
      event.keyId === this.config.keyId ||
      (event.kind !== 'moving' && event.kind !== 'state') ||
      (event.kind === 'moving' ? event.target : event.position) === POSITIONS.LOCKED
    ) {
      return;
    }
    if (seconds * 1000 >= last.wall + 2_000 && at >= last.wall + 2_000) {
      this.memory.pendingLock = null;
      this.cancel('pending');
      if (this.memoryState === 'ok') this.kickSave();
      this.setLastCommand(C.lockOverridden);
    }
  }

  // --- Actions --------------------------------------------------------------------------

  /** The pause asked by the bridge, as a message with the time left; undefined when none. */
  pauseMessage(entry) {
    const left = this.pauseUntilMono - this.monotonic();
    if (!(left > 0)) return undefined;
    return message(entry, { seconds: Math.ceil(left / 1000) });
  }

  /**
   * "Test the connection": never a read faster than the interval (a read
   * younger than it is used as is), never during a pause; one read at most.
   */
  async testConnection() {
    const language = this.config.language;
    const mono = this.monotonic();
    const interval = this.config.pollInterval * 1000;
    if (mono - this.lastTest < Math.max(TIMINGS.testCooldown, interval)) {
      return word(A.testWait, language);
    }
    if (this.config.problem) return word(A.testNoConfig, language);
    const paused = this.pauseMessage(A.testPaused);
    if (paused) return paused[language];
    this.lastTest = mono;
    let status;
    const fresh =
      this.failures === 0 &&
      this.observed.at > 0 &&
      this.memory.mac &&
      this.now() - this.memory.lastTry < interval;
    if (fresh || this.memory.otherMac) {
      status = this.memory.otherMac
        ? { mac: this.memory.otherMac }
        : { mac: this.memory.mac, ...this.observed };
    } else {
      status = await this.readOnce();
      if (!status) {
        return word(
          this.lastError === ERROR_KINDS.BAD_RESPONSE ? A.testBadAnswer : A.testFailed,
          language,
        );
      }
    }
    if (this.memory.mac && status.mac !== this.memory.mac) {
      return message(A.testOther, { mac: status.mac })[language];
    }
    // A successful test lifts the refusal of the key: a waiting lock leaves first.
    if (this.memory.keyRefused) {
      this.memory.keyRefused = null;
      if (this.memoryState === 'ok') this.kickSave();
      if (this.memory.pendingLock) await this.sendLock({ clicked: false });
    }
    if (this.config.hookProblem) {
      this.hookState = 'off';
    } else {
      await this.ensureReceiver().catch(() => {});
    }
    await this.updateStatus();
    const hooks = {
      ok: A.hooksOk,
      refused: A.hooksRefused,
      failed: A.hooksFailed,
      off: A.hooksOff,
    }[this.hookState];
    const position = status.position;
    return message(A.testOk, {
      mac: status.mac,
      position: position ? word(POSITION_TEXT[position], language) : word(A.unknown, language),
      battery: status.battery === undefined ? word(A.unknown, language) : `${status.battery} %`,
      hooks: word(hooks, language),
    })[language];
  }

  /** GET /status for an action: nothing applied. */
  async readStatusOnly() {
    try {
      const answer = await this.request({
        host: this.config.host,
        port: this.config.port,
        method: 'GET',
        path: ENDPOINTS.STATUS,
        timeout: TIMINGS.readTimeout,
        stallMs: TIMINGS.stallTimeout,
        json: true,
        timers: this.timers,
      });
      const status = parseStatus(answer.json);
      return status ? { ok: true, status } : { ok: false, kind: ERROR_KINDS.BAD_RESPONSE };
    } catch (err) {
      return { ok: false, kind: err.kind };
    }
  }

  /** "Use the bridge now answering": two clicks within a minute, the same MAC both times. */
  async adoptBridge() {
    const language = this.config.language;
    if (this.config.problem) return word(A.testNoConfig, language);
    if (this.memoryState !== 'ok') return word(A.adoptData, language);
    const paused = this.pauseMessage(A.testPaused);
    if (paused) return paused[language];
    const read = await this.readStatusOnly();
    if (!read.ok) return word(A.adoptFailed, language);
    const mac = read.status.mac;
    if (mac === this.memory.mac && !this.memory.otherMac) return word(A.adoptNone, language);
    const mono = this.monotonic();
    if (!this.adopt || this.adopt.mac !== mac || mono - this.adopt.mono > TIMINGS.adoptConfirm) {
      this.adopt = { mac, mono };
      return message(A.adoptConfirm, { mac })[language];
    }
    this.adopt = undefined;
    const before = { mac: this.memory.mac, otherMac: this.memory.otherMac };
    this.memory.mac = mac;
    this.memory.otherMac = null;
    try {
      await this.saveMemory();
    } catch {
      Object.assign(this.memory, before);
      return word(A.adoptData, language);
    }
    this.discovered = undefined;
    this.transports.clear();
    await this.publishDiscovery();
    await this.read();
    return message(A.adoptDone, { mac })[language];
  }
}
