# gladys-loqed

[Gladys Assistant](https://gladysassistant.com) external integration for the
**LOQED Touch** smart lock, through the local API of its bridge, without the
LOQED cloud: lock state, battery, and Lock / Unlock / Open buttons (unlocking
and opening off by default). Unofficial, not affiliated with LOQED.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Work in progress.** First milestone, tested against a fake bridge only,
> never with a real LOQED lock.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (LoqedApp)
                                   ├─ src/bridge.js     one HTTP request per connection, bounded, beforeSend before the first byte
                                   ├─ src/loqed.js      signed commands, webhook hashes, /status and events (pure, from loqedAPI)
                                   ├─ src/devices.js    -> one Gladys device keyed on the bridge MAC; buttons, never a switch
                                   ├─ src/publisher.js  states within 250/min (Gladys: 300)
                                   ├─ src/store.js      /data/loqed.json: identity, waiting lock, guards, refusals (bounded I/O)
                                   └─ src/channel.js ⇄ loqed-webhook sub-container (src/receiver.js)
                                                         └─ src/push/service.js  HTTP :8080, published by Gladys
```

- **API** (ported from loqedAPI 2.1.18, BSD-2-Clause, the library of Home
  Assistant's LOQED integration): `GET http://<bridge>/status` (no
  credentials), `GET /to_lock?command_signed_base64=…` (53 bytes signed with
  HMAC-SHA256 and the local key: protocol 2, type 7, time, key id, action
  open 1 / unlock 2 / lock 3), `GET|POST|DELETE /webhooks` (TIMESTAMP + HASH
  = SHA-256 of fields, time and bridge key).
- **Webhooks**: the main container of an integration has no published port;
  a sub-container of the same image (`node src/receiver.js`, `start: manual`)
  serves exactly `POST /loqed/<token>` on a port Gladys publishes, bounded
  (4 KB, 16 connections, 4 per sender, 10 s, 120 a minute), and hands each
  webhook (raw bytes, TIMESTAMP, HASH, sender, time) to the main container
  over a private TCP channel authenticated both ways (from gladys-nasweb). The
  main container checks the signature with the bridge key (which never
  enters the receiver), the time, replays, the sender and the bridge MAC.
- **Lock** never held back; kept in `/data` until a read started after it
  shows the lock locked; only a 2xx-answered send counts as a try (3 at most).
- **Unlock / Open** off by default, decided on a fresh read, guard written to
  `/data` before the first byte, last checks in `beforeSend`.

## Development

```bash
npm install
npm test               # node --test test/*.test.js (fake bridge on 127.0.0.1, real receiver)
npm run lint
npm run format:check
npm run cover          # regenerate cover.png (800×534)
```

Full CI locally on this VM: `gi ci`. See `CLAUDE.md` for the project rules and
`TODO.md` for the status and the decisions.

## License

Apache-2.0 (see `LICENSE`). Third-party notices: `THIRD_PARTY_NOTICES.md`.
