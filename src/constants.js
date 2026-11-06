// -----------------------------------------------------------------------------
// Fixed values: the local API of the LOQED bridge (as loqedAPI 2.1.18,
// BSD-2-Clause, reads it), manifest keys (frozen: users store them), the
// webhook receiver sub-container, feature keys, limits and timings.
// -----------------------------------------------------------------------------

/** The endpoints of the bridge (plain HTTP on port 80). */
export const ENDPOINTS = {
  /** GET, no credentials: lock state, battery, MAC addresses of the bridge. */
  STATUS: '/status',
  /** GET with `command_signed_base64`: a command signed with the local key. */
  TO_LOCK: '/to_lock',
  /** GET, POST, DELETE /webhooks/<id>: signed with the bridge key (TIMESTAMP + HASH headers). */
  WEBHOOKS: '/webhooks',
};

/** The command actions of the LOQED protocol (loqedAPI Action). */
export const ACTION_CODES = {
  OPEN: 1,
  UNLOCK: 2,
  LOCK: 3,
};

/** Every webhook trigger of the bridge (loqedAPI registerWebhook flags 511). */
export const WEBHOOK_FLAGS = 511;

/** The bolt positions the module knows, as the bridge names them in /status. */
export const POSITIONS = {
  LOCKED: 'locked',
  UNLOCKED: 'unlocked',
  OPEN: 'open',
  MOVING: 'moving',
  JAMMED: 'jammed',
};

/** Feature keys (the last part of the feature external ids): frozen. */
export const FEATURES = {
  STATE: 'state',
  POSITION: 'position',
  BATTERY: 'battery',
  LOCK: 'lock',
  UNLOCK: 'unlock',
  OPEN: 'open',
  LAST_COMMAND: 'last_command',
};

/** The external id type (middle part of the device external id): frozen. */
export const EXTERNAL_ID_TYPE = 'bridge';

/** Manifest `actions` keys: frozen. */
export const ACTIONS = {
  TEST: 'test_connection',
  ADOPT: 'adopt_bridge',
};

/** The webhook receiver of the manifest `containers` (same image, `node src/receiver.js`). */
export const RECEIVER = {
  name: 'loqed-webhook',
  /** HTTP port the bridge calls, published by Gladys on a host port it chooses. */
  httpPort: 8080,
  httpPortName: 'loqed_webhook',
  /** Channel to the main container, on the private network of the integration only. */
  channelPort: 7779,
  /** The path the bridge posts to: /loqed/<webhook token>. */
  pathPrefix: '/loqed/',
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const LIMITS = {
  /** Gladys accepts 300 states per minute: a margin is kept. */
  statesPerMinute: 250,
  /** An answer of the bridge (/status, /webhooks): a few hundred bytes. */
  responseBytes: 16 * 1024,
  /** A webhook body: one event, a few hundred bytes. */
  webhookBytes: 4 * 1024,
  /** Webhooks accepted per minute by the receiver, in all and per source address. */
  webhooksPerMinute: 120,
  webhooksPerSource: 30,
  /** Connections of the receiver: in all, per source address; idle time before closing. */
  receiverConnections: 16,
  receiverConnectionsPerSource: 4,
  receiverIdleMs: 10_000,
  /** Webhooks kept by the receiver while the main container is away. */
  webhookQueue: 20,
  /** Webhook hashes remembered against replays (each one for `webhookSkew` x 2). */
  replayCache: 256,
  /** Webhooks listed by the bridge that are looked at. */
  webhooksListed: 64,
  /** Names are cut to this length. */
  nameLength: 60,
  /** The secrets the integration generates (base64url characters). */
  tokenLength: 32,
  /** Effective sends (answered 2xx) of one lock click that stay unconfirmed before it is given up. */
  lockSends: 3,
  /** The /data file. */
  memoryBytes: 8 * 1024,
};

export const TIMINGS = {
  /** A read of /status: the whole answer, and at most this long without a byte. */
  readTimeout: 4 * SECOND,
  stallTimeout: SECOND,
  /** A webhook management request. */
  hookTimeout: 5 * SECOND,
  /** A command request: the answer is awaited this long after the bytes left. */
  commandTimeout: 2_500,
  /** A lock that could not leave (no connection) is tried again within this budget. */
  lockBudget: 250,
  lockRetryGap: 50,
  /** Reads after a command, from the send (the motor takes a few seconds). */
  followUps: [1_500, 4_000, 8_000, 15_000, 30_000],
  /** A lock still unconfirmed this long after its last send is sent again (by a read). */
  lockResendAfter: 6 * SECOND,
  /** While a lock waits, the bridge is read at least this often. */
  lockPendingRead: 10 * SECOND,
  /** Gladys acks a command after 5 s: a sensitive command leaves by 3.5 s or never. */
  commandSendBy: 3_500,
  /** The fresh read of a sensitive command ends by this time after the click. */
  commandReadBy: 2_500,
  /** The guard of a sensitive command must be in /data by this time after the click. */
  commandSaveBy: 3_200,
  /** /data unreadable: read again this often, whatever the interval. */
  memoryRetry: 10 * SECOND,
  /** /data reads and writes awaited at most this long. */
  storeTimeout: 2 * SECOND,
  /** Webhooks: the bridge timestamp within this much of the receiver clock (loqedAPI: 10 s). */
  webhookSkew: 30 * SECOND,
  /** A webhook is applied only while it is this fresh (receiver time). */
  webhookFresh: 60 * SECOND,
  /** After a command, webhook states only trigger a read for this long. */
  commandWindow: 20 * SECOND,
  /** The webhook at the bridge is checked this often. */
  hookCheck: 30 * MINUTE,
  /** The receiver is started again at most this often when it is not running. */
  receiverRetry: MINUTE,
  /** getConfig() failed: tried again after these delays (the last one repeats). */
  configRetry: [5 * SECOND, 15 * SECOND, 30 * SECOND, MINUTE],
  /** Reads failing: the next one after these delays, capped by the interval x 10. */
  backoff: [10 * SECOND, 30 * SECOND, MINUTE, 5 * MINUTE],
  /** 429 / 5xx of the bridge: pause bounds. */
  pauseMin: MINUTE,
  pauseMax: 6 * HOUR,
  /** "Test the connection" at most this often. */
  testCooldown: 10 * SECOND,
  /** The second click of "Use the bridge now answering" within this time. */
  adoptConfirm: MINUTE,
  /** Refused webhooks update the status at most this often. */
  refusedStatusEvery: 10 * SECOND,
  /** States not seen for this long are no longer published (2 h rule). */
  stateMaxAge: 2 * HOUR,
};
