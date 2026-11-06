# TODO — LOQED v1

Handoff document: what is done, what was decided, what comes next.

## Status

- [x] **Milestone 1** (2026-11-05, local commit, not pushed): local API of the
      bridge (`/status`, `/to_lock`, `/webhooks`), one device per bridge,
      lock never held back, unlock and open off by default and guarded,
      webhook receiver sub-container, actions, en/fr, docs, cover. Tested
      against a fake bridge (signatures checked) and the real receiver on the
      loopback only. **Never tested with a real lock.**
- [ ] **Milestone 2 — real bridge**: see "To check".
- [ ] **First release**: Docker image, topic, GHCR package public.

## To check on a real bridge

- Where the LOQED app shows the local API key and the exact names of its
  fields (`bridge_ip`, `lock_key_local_id`, `lock_key_key`, `bridge_key`, as
  in Home Assistant's `integration_config.json` fixture).
- The answer of `/to_lock`: status and body for an accepted command, for a bad
  signature (assumed 401/403 = key refused) and for a stale time (how much
  clock drift the bridge accepts).
- Whether the bridge serves two connections at once (a lock is sent while a
  read may be in flight; the read is aborted).
- `bolt_state` values seen in `/status` (night_lock, night_lock_remote,
  day_lock, open, unknown, motor_stall?) and how long `open` lasts.
- The webhook bodies (event names, `key_local_id`, `mac_wifi` format) and how
  many webhooks the bridge keeps; whether it accepts our URL with a port.
- The MAC format of `bridge_mac_wifi` (12 hex assumed, ":" accepted).

## Decisions

- **Not a duplicate**: no LOQED integration in the store (checked 2026-11-05).
- **Reference: cpolhout/loqedAPI 2.1.18** (BSD-2-Clause, PyPI 2026-10-12,
  GitHub 5e1123f), the library of Home Assistant's LOQED integration; license
  read in its `LICENSE`. Its `loqed.py` (the local bridge client) is ported to
  JavaScript (`src/loqed.js`), checked byte for byte against vectors computed
  with its code; notice in `THIRD_PARTY_NOTICES.md`, shipped in the image.
  Home Assistant's integration (Apache-2.0) read for the mapping and the
  fixtures. No User-Agent or application imitated: the bridge API is the
  manufacturer's documented local integration API.
- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and both `docker_image` tags (main and `loqed-webhook`); the first
  patch release gives 0.1.1. No `keywords` nor `countries` in the manifest
  (NL, EU product).
- **Identity**: the device external id is `bridge:<bridge_mac_wifi>` (12 lower
  hex), the value Home Assistant keys the lock on; written to `/data` before
  use; another MAC at the address is refused (not published, unlock and open
  refused) until "Use the bridge now answering" (two clicks within 60 s, the
  same MAC both times). `/data` unreadable: no identity learnt, nothing
  written.
- **Features**: `state` lock/state read only (1 night lock, 0 day lock or
  open, 2 moving, 3 motor stall; nothing for `unknown`), `position` text,
  `battery` % (never while the lock is away: the bridge says -1),
  `lock`/`unlock`/`open` button/push (value 1 only), `last_command` text. No
  switch, no commandable binary, no `supported_options`.
- **Lock** (protective): leaves at once, whatever the options, the pause, the
  identity, a read in flight (aborted: an aborted read is not a failure),
  /data (never awaited on its path: saves are kicked, bounded to 2 s). Tried
  again for 250 ms while no connection opens; then kept in `/data`
  (`pendingLock`) and handled every 10 s: sent if it never left, else a read,
  which confirms it (a read started after the send showing night lock) or
  sends it again (6 s after the last send at least). Only a send answered 2xx
  counts (3 at most, then given up with a message); a cut, a timeout, a 4xx,
  a 5xx, a 429 or a refused key never count; no age limit. Sent at a restart
  as soon as the configuration is read (the local key lives in the Gladys
  configuration, never in /data), before any read. A future or odd click time
  in /data becomes "now", an odd count 0: a waiting lock is never dropped by
  its record. A movement reported by a signed webhook with another key id,
  dated at least 2 s after the send on both clocks (bridge and receiver),
  ends it (the user unlocked with the app); in doubt, it goes again.
- **Key refused** (401/403 on `/to_lock`): persisted with 8 bits of a salted
  hash of the refused key and key id only; no automatic send; a click still
  sends once; lifted by another key or key id saved (also across a restart),
  by a successful "Test the connection" (the waiting lock leaves first) or by
  a 2xx answer.
- **Unlock / open** (sensitive): `allow_unlock`; open needs `allow_open` and
  `allow_unlock`. One at a time (a second is refused, not queued). Refused
  while a lock waits or is being sent, after a key refusal, without identity.
  Decided on a read started after the click (2.5 s at most): same MAC, lock
  online, night lock / day lock / open only; unlock on an unlocked lock sends
  nothing. Guard `{ action, at }` written to /data before the first byte
  (2 s at most, and 3.2 s after the click at most; refused otherwise),
  cleared after. Refused during a pause of the bridge (time left in the
  reason). `beforeSend` checks the
  option, a lock clicked since (epoch), the key refusal and 3.5 s after the
  click, synchronously before the first byte; the answer is awaited until
  4.6 s. Left without an answer: "sent, without confirmation" (an error ack:
  never a success, never "nothing sent").
- **Reads**: one at a time (a read asked during one runs after it);
  `/status` 4 s, cut after 1 s without a byte; the time of the attempt goes to
  /data first (kicked); never faster than the interval across a restart. A
  read is void when a command left or a lock was clicked while it was out, or
  when a newer read or webhook was applied (reads apply in the order they
  started). 429 / 5xx: pause `Retry-After` (else 60 s doubling) clamped to
  1 min–6 h, in /data, on every path but the lock: scheduled, follow-up and
  webhook reads, unlock/open (refused), the actions; the reads of a waiting
  lock still go (review r1, I2). Follow-up reads 1.5, 4, 8, 15, 30 s after a
  command. "Test the connection": one read at most, never more often than
  the interval (a newer read is reused).
- **/data** (review r1, B1/B2): a lock clicked before or while /data is read
  is merged with what it holds (the latest click wins), written, sent first.
  /data unreadable (or slow past 2 s) is read again, bounded, every 10 s on
  a timer of its own (review r2, I1) and at each scheduled read; once
  readable, its lock leaves at once and the 10 s round is armed. The round
  of a waiting lock never waits for /data (r2, m3). The status is sent again
  at every result of a lock (r2, m1). The test button tells the time left;
  only a test that read holds the next one for the interval (r2, m2). A
  stuck read of /data is never doubled: the next try awaits the same one,
  in the app and in the file store (r3, m1).
- **Replays after a restart** (review r1, m1): the replay cache lives in
  memory; a webhook dated (bridge time) before the start only triggers a
  read.
- **Webhooks**: the main container has no published port: a sub-container of
  the same image (`loqed-webhook`, `start: manual`, read only, 64 MB) serves
  `POST /loqed/<token>` (32+ random characters, compared in constant time),
  needs TIMESTAMP and HASH headers, 4 KB, 16 connections (4 per sender,
  oldest silent closed), headers 5 s, request 10 s, 120 a minute (30 for a
  sender that is not the bridge), other senders 403 before any budget when
  the check is on (`DEVICE_ADDRESS`). It forwards raw bytes in base64 over
  the channel of gladys-nasweb (HMAC challenge both ways). The bridge key
  never enters the receiver: the main container checks the hash (constant
  time), the bridge time within 30 s of the receiver time, a webhook kept
  over 60 s ignored, replays (hash cache, 256), the sender (option
  `check_webhook_source`, on by default) and `mac_wifi`. Around a command (a
  lock waiting or sending, an unlock in progress, 20 s after any send) a
  state event only triggers a read. The tokens are generated once and kept in
  the Gladys configuration outside the `config_schema`; /data keeps 8 hex of
  the hash of each URL we registered, to withdraw only our old ones.
- **Registration** at the bridge: GET /webhooks, POST when our URL is
  missing, DELETE only of URLs we registered (by hash). Secondary: a failure
  or a refused bridge key never blocks reads or commands (status says it);
  checked every 30 min (5 min after a failure).
- **getConfig() in `connected`**: tried again without end (5, 15, 30, 60 s),
  status "trying again".
- **Clocks**: decisions on the monotonic clock; the wall clock only for /data,
  the command time (the protocol needs it) and the webhook time checks.
