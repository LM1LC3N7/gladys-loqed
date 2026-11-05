# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test test/*.test.js (60 s per test at most)
node --test test/app.test.js              # one file
node --test --test-name-pattern "unlock"  # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js, before connect())
src/handlers.js                   the SDK handlers -> LoqedApp (shared with the tests)
src/app.js                        LoqedApp: reads, webhooks, devices, commands and their safety rules
src/bridge.js                     HTTP client of the bridge (bounded, beforeSend, notSent)
src/loqed.js                      the LOQED protocol, pure (ported from loqedAPI, BSD-2-Clause)
src/devices.js                    the Gladys device of the lock (pure)
src/publisher.js                  states to Gladys within 250/min
src/store.js                      /data/loqed.json, every load and save bounded in time
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/channel.js                    the authenticated channel main container <-> receiver
src/receiver.js, src/push/        the loqed-webhook sub-container (HTTP endpoint of the webhooks)
src/constants.js, src/i18n.js     protocol values, limits, timings; en/fr texts
gladys-assistant-integration.json manifest: name, config_schema, containers, actions...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test: SDK fake Gladys + fake bridge on 127.0.0.1
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
TODO.md                           status, things to check on a real bridge, decisions
THIRD_PARTY_NOTICES.md            BSD-2-Clause notice of loqedAPI, copied into the image
```

## Safety rules (lock)

Locking is never held back: not by the options, a read in flight (cancelled),
a pause, the identity of the bridge, or /data (never awaited on its path). It
is kept in /data until a read started after it shows the lock locked; only a
send answered 2xx counts as a try (3 at most); one that never left is never
given up. Unlocking (`allow_unlock`) and opening (`allow_open`, which needs
`allow_unlock` too) stay off by default, are buttons (never a switch nor a
commandable binary), run one at a time, are decided on a read started after
the click, write their guard to /data before the first byte, and check the
option, a lock clicked since and the 3.5 s deadline again in `beforeSend`. A
read started before a command is never applied after it. Never weaken these
rules; every guard has a test that fails when it is removed.

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (serial, cloud id, MAC), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates a
  new device and orphans the old one. The same goes for every key users store:
  manifest `config_schema`, `actions`, widget and scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action, scene and widget handlers): change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never leave 127.0.0.1 (the fake bridge), and every wait in
  a test is bounded: a test fails, it never hangs.
