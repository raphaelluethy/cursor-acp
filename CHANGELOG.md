# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-05-21

### Added

- SDK-only backend using [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk) for prompt execution, model listing, authentication, and agent resume.
- Dynamic ACP config options for SDK model parameters: `fast`, `reasoning`, `effort`, and `thinking` (when supported by the selected model).
- Thought level selection exposed as an ACP config option (`thought_level` category) with ids matching SDK parameter metadata.
- Fallback environment variables: `CURSOR_ACP_DEFAULT_THINKING` alongside existing `CURSOR_ACP_DEFAULT_MODE` and `CURSOR_ACP_DEFAULT_MODEL`.
- Local custom slash commands and skills resolved from project/user command files where supported.

### Changed

- **Major release:** prompt execution no longer spawns `cursor-agent` subprocesses. `CURSOR_API_KEY` is required.
- **Yolo mode (`yolo`):** retries rejected tool calls with forced local SDK execution when the user approves always, instead of auto-answering native ACP permission prompts.
- **Model selection:** model ids are SDK catalog ids only. The SDK `default` model id is mapped to **`auto`** in the adapter. Fast mode is configured through the SDK `fast` parameter, not separate model ids or bracket syntax.
- **Resume:** sessions replay local JSONL history and resume SDK agent ids when available, instead of native `session/load` against `cursor-agent acp`.
- **Slash commands:** built-in wrapper commands (`/help`, `/model`, `/mode`, `/status`, `/login`, `/logout`) are handled locally. `/login` and `/logout` describe API-key setup instead of driving CLI login flows.
- **Authentication:** `/status` verifies `CURSOR_API_KEY` via `Cursor.me()`.

### Removed

- All `cursor-agent` integration: native ACP bridge, legacy `--print --output-format stream-json` runner, and hybrid backend switching.
- Advertised **Ask** mode (legacy alias `ask` still maps to `default`).
- Legacy Yolo mode name aliases: `bypassPermissions`, `autoRunAllCommands`.
- Legacy model id bracket syntax such as `composer-2[fast=true]`.
- Native Cursor extension RPC forwarding (`cursor/*` methods and notifications).
- Native command precedence over wrapper slash commands.
- Turn-closing markdown recap for tool-only turns.
- Terminal-auth metadata for CLI-based login flows.
- **`debug`** wrapper mode (intentionally not exposed).

### Migration

See [`docs/breaking-changes.md`](docs/breaking-changes.md) for the full upgrade guide from 0.x.

## [0.7.2] and earlier

Pre-1.0 releases used a hybrid or CLI-backed backend (`cursor-agent acp` plus the legacy stream-json prompt path). Refer to the README on the `main` branch for 0.x behavior and configuration.

[1.0.0]: https://github.com/raphaelluethy/cursor-acp/compare/v0.7.2...v1.0.0
