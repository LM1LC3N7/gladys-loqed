# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-11-06

### Added

- LOQED Touch smart lock through the local API of its bridge: lock state
  (locked, unlocked, open, moving, jammed), position, battery, last command.
- Lock button, always allowed and never held back; kept until a read shows
  the lock locked, sent again (3 accepted sends at most).
- Unlock and Open buttons, off by default (`allow_unlock`, `allow_open`),
  decided on a fresh read, guarded in `/data` before they leave.
- Webhooks of the bridge through the `loqed-webhook` receiver: signature,
  time, replay, sender and bridge checked; registered by the integration.
- "Test the connection" and "Use the bridge now answering" actions.

[Unreleased]: https://github.com/LM1LC3N7/gladys-loqed/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-loqed/releases/tag/v0.1.1
