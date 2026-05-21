# cursor-acp

> **Why does this exist?** Cursor published their own ACP client, but using it in Zed was rough as I somehow had to permit tool calls the whole time.

Disclaimer: I am not affiliated with Cursor or Zed. This project is a personal experiment and should not be considered an official product of either company. I am a big fan of both products and wanted to combine what I like with both of them: An amazing editor and a great AI coding agent (and composer-1, holy this model flies xD).

An [Agent Client Protocol (ACP)](https://github.com/agentclientprotocol/agent-client-protocol) adapter for [Cursor](https://cursor.com), enabling Cursor's AI coding assistant to be used within [Zed](https://zed.dev) and other ACP-compatible clients. Prompt execution uses [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk) and requires `CURSOR_API_KEY`.

## About

This is an `ai-assisted` personal project aimed at bringing Cursor's agent into Zed. It uses the Cursor SDK directly:

- **Prompt execution**: [`@cursor/sdk`](https://cursor.com/docs/sdk/typescript) local agents when `CURSOR_API_KEY` is configured.
- **Session compatibility**: local session persistence, history replay, model selection, and mode handling live in this adapter.

**Based on [claude-code-acp](https://github.com/zed-industries/claude-code-acp)** by Zed Industries - the original ACP adapter for Claude Code that served as the architectural foundation for this project.

## Features

### SDK backend

- **Prompt execution**: Runs prompt turns through `@cursor/sdk`, then adapts SDK events into ACP session updates
- **Tool and message streaming**: Preserves shell tool command text and streams assistant/tool updates to ACP clients
- **Mode switching**: Supports `default`, `yolo`, and `plan`

### Wrapper compatibility

- **ACP session lifecycle**: Supports `new`, `resume`, and `fork` (best-effort) session operations
- **Session persistence & history replay**: Stores visible history locally and replays it on resume/load
- **Session listing**: Lists past local sessions with optional cwd filtering and pagination
- **Model listing and best-effort model selection**: Keeps `/model` support through SDK model APIs
- **Thought level selection**: Exposes reasoning/thinking effort as an ACP config option (category `thought_level`) when the selected model supports SDK `reasoning`, `effort`, or `thinking` parameters. The config option id matches the SDK parameter id; defaults are resolved from the model's variant metadata
- **Fast model variants**: Composer and other models expose fast variants as separate SDK model ids (e.g. `composer-2-fast`); select them directly in the model picker or via `/model`
- **Authentication helpers**: `/login`, `/logout`, `/status` describe or verify SDK API-key authentication
- **Prompt flattening for ACP clients**: Keeps embedded context and image prompts working by converting them to text before forwarding to the SDK
- **Optional Yolo mode** (`yolo`): retries rejected tool calls with forced local execution when explicitly approved

### Known limitations

- `CURSOR_API_KEY` is required
- Resuming after restarting `cursor-acp` replays local JSONL so visible history is preserved and resumes SDK agents when possible
- `debug` mode is intentionally not exposed in this phase

## Breaking changes (SDK-only backend & Yolo)

The current release removes all Cursor command subprocess integration. Prompt execution, model listing, and authentication now use `@cursor/sdk` only.

### Configuration defaults

Prefer ACP client defaults, such as Zed’s inline `default_mode` / `default_model` fields on the custom agent entry. The adapter still reads `CURSOR_ACP_DEFAULT_MODE`, `CURSOR_ACP_DEFAULT_MODEL`, and `CURSOR_ACP_DEFAULT_THINKING` as fallback values when the client does not send defaults.

### Legacy Yolo mode name aliases removed

Older builds accepted `bypassPermissions` and `autoRunAllCommands` as synonyms for **`yolo`** in `default_mode` and in `/mode`. Those names are **no longer accepted**—use **`yolo`** (or pick **Yolo** in the client).

### SDK-only backend

- **Execution model**: Prompt turns run through `@cursor/sdk`.
- **Slash commands**: Built-in wrapper commands are handled locally.
- **Permissions**: Wrapper mode handling controls retries and Yolo behavior.
- **Resume / listing**: Resume and list are backed by local session storage plus SDK agent ids when available.

### Yolo mode (`yolo`)

- **What it does now**: **Yolo** retries rejected tool calls with forced local execution when the user approves always.
- **Why that can break expectations**: If you relied on old auto-approval semantics or legacy mode names, behavior may differ because the backend is now SDK-only.
- **Configuration**: Set `default_mode` to **`yolo`** in your ACP client configuration (for example the Zed custom agent entry) to get automatic approval. Do not use legacy names like `bypassPermissions` or `autoRunAllCommands`; see **Legacy Yolo mode name aliases removed**.

### Ask mode removed

- **What changed**: **Ask** is no longer an advertised wrapper mode. The mode picker and `/mode` command now expose **`default`**, **`yolo`**, and **`plan`** only.
- **Legacy alias**: `ask` still maps to **`default`** in `default_mode`, `/mode`, and stored session metadata so older configs keep working.
- **Why it was removed**: `@cursor/sdk` does not expose Ask mode, and the separate Ask path added complexity without a stable long-term API to target.

### Legacy model id syntax removed

- **What changed**: Model ids are SDK ids only. Bracket syntax such as `composer-2[fast=true]` or `default[fast=true]` is no longer accepted.
- **Fast variants**: Use the SDK model id directly (for example `composer-2-fast`).
- **Auto model**: The SDK `default` model id is mapped to **`auto`** in the adapter; configure `default_model` with either id.
- **Thought level config**: The ACP config option id is the SDK parameter id (`reasoning`, `effort`, or `thinking`), not a hardcoded `thinking` id.

The same notices are linked from [`docs/breaking-changes.md`](docs/breaking-changes.md).

## Slash Commands

| Command   | Description                            |
| --------- | -------------------------------------- |
| `/help`   | Show available commands                |
| `/model`  | Switch or display the current model    |
| `/mode`   | Switch or display the current mode     |
| `/status` | Show authentication and session status |
| `/login`  | Show API-key authentication setup      |
| `/logout` | Explain how to clear API-key auth      |

Custom Cursor command files and skills are resolved locally where supported.

## Installation

```bash
bun install
export CURSOR_API_KEY="your-key"
bun run build
```

This compiles the project and produces the `cursor-acp` binary entry point at `./dist/index.js`. The entry point uses a Bun shebang; **`bun install` runs a postinstall step that builds `sqlite3`** (a native dependency of `@cursor/sdk` used for local agent persistence when `CURSOR_API_KEY` is set).

### Adding to PATH

For Zed to find the `cursor-acp` command, it needs to be available on your PATH. Choose one of the following options:

**Option A — npm link (recommended)**

Run `npm link` inside the repository root to symlink the `cursor-acp` binary globally:

```bash
npm link
```

**Option B — manual symlink**

Create a symlink manually:

```bash
ln -s "$(pwd)/dist/index.js" /usr/local/bin/cursor-acp
```

Verify the binary is accessible:

```bash
which cursor-acp
```

## Usage

### Run directly

```bash
export CURSOR_API_KEY="your-key"
bun run start
```

Or use the binary:

```bash
cursor-acp
```

### Configuring Zed

Open your Zed settings file via the Command Palette (`zed: open settings`) and add a custom agent server entry under `agent_servers`:

```json
{
  "agent_servers": {
    "Cursor": {
      "type": "custom",
      "command": "cursor-acp",
      "args": [],
      "default_mode": "yolo"
    }
  }
}
```

If `cursor-acp` is not on your PATH, use the full absolute path to the entry point instead:

```json
{
  "agent_servers": {
    "Cursor": {
      "type": "custom",
      "command": "/absolute/path/to/cursor-acp/dist/index.js",
      "args": [],
      "default_mode": "yolo"
    }
  }
}
```

#### Default mode, model, and thinking level

Zed (and other ACP clients) can pass the initial mode, model, and optional thinking level through the ACP `session/new` or `initialize` request. Put them directly on the custom agent entry (or via `_meta` for some clients):

```json
{
  "agent_servers": {
    "Cursor": {
      "type": "custom",
      "command": "cursor-acp",
      "args": [],
      "default_mode": "yolo",
      "default_model": "gpt-5.4-mini-medium",
      "default_thinking": "medium"
    }
  }
}
```

- `default_mode` — one of `default`, `yolo`, or `plan` (legacy aliases: `acceptEdits` → `default`, `ask` → `default`)
- `default_model` — optional model ID (use `composer-2-fast` or similar for fast variants of composer models; the legacy `composer-2[fast=true]` form is normalized automatically)
- `default_thinking` (or `default_thinking_level`, `thinking`) — optional thinking/reasoning level for models that expose `reasoning` / `effort` / `thinking` parameters

Omit keys you do not need. There is no separate adapter-specific config file for these defaults anymore. As a fallback, `CURSOR_ACP_DEFAULT_MODE`, `CURSOR_ACP_DEFAULT_MODEL`, and `CURSOR_ACP_DEFAULT_THINKING` can be set in the adapter process environment.

The mode picker in Zed (and other ACP clients) lists **Default**, **Yolo**, and **Plan**. Thinking level (when applicable) and model pickers appear as dynamic config options in the session.

### Using in Zed

1. Open the Agent Panel with `Cmd+?` (macOS) or `Ctrl+?` (Linux)
2. Click the `+` button in the top right and select **Cursor**
3. Make sure `CURSOR_API_KEY` is available to the process that launches `cursor-acp`
4. The default mode is `default`; if you want tool execution without repeated prompts, set `"default_mode": "yolo"` on the Zed agent entry

You can also bind a keyboard shortcut to quickly open a new Cursor thread by adding the following to your `keymap.json` (open via `zed: open keymap file`):

```json
[
  {
    "bindings": {
      "cmd-alt-u": ["agent::NewExternalAgentThread", { "agent": "Cursor" }]
    }
  }
]
```

### Debugging

If something isn't working, open Zed's Command Palette and run `dev: open acp logs` to inspect the ACP messages being sent between Zed and cursor-acp.

Set `CURSOR_ACP_DEBUG_LOG=1` if you also want the adapter to write extra debug traces to `~/.cursor-acp/logs/debug.log`.

### Development

```bash
bun run dev
```

### Testing

```bash
bun run test           # Run tests in watch mode
bun run test:run       # Run tests once
```

### Linting & Formatting

```bash
bun run lint        # Check for linting issues
bun run lint:fix    # Auto-fix linting issues
bun run format      # Format code with oxfmt
bun run check       # Run lint and format checks
```

## Migration Notes

- See **Breaking changes (SDK-only backend & Yolo)**, **Ask mode removed**, and **Legacy model id syntax removed** for semantic and protocol differences when upgrading from older builds.
- Model ids must match the Cursor SDK catalog (for example `composer-2-fast`, not `composer-2[fast=true]`)
- Thought level config options use SDK parameter ids (`reasoning`, `effort`, or `thinking`), not a fixed `thinking` config id
- `default`, `yolo`, and `plan` are the advertised modes
- `acceptEdits` is a deprecated alias for `default` (still accepted). `ask` is a deprecated alias for `default`. For Yolo, use **`yolo`**—`bypassPermissions` and `autoRunAllCommands` are no longer accepted (see **Legacy Yolo mode name aliases removed**)
- `debug` is not exposed
- Custom commands and skills are resolved locally where supported

## Project Structure

```
src/
├── index.ts              # Binary entry point
├── lib.ts                # Library exports
├── cursor-acp-agent.ts   # Outer ACP agent + compatibility layer
├── cursor-sdk-runner.ts  # @cursor/sdk prompt runner
├── cursor-runner.ts      # Runner interfaces
├── cursor-runner-provider.ts # SDK runner loader
├── cursor-sdk-event-adapter.ts # SDKMessage → Cursor stream events
├── prompt-conversion.ts  # Flattens ACP prompts for SDK forwarding
├── auth.ts               # Authentication handling
├── settings.ts           # Mode ids and normalization helpers
├── session-storage.ts    # Session persistence and history replay
├── slash-commands.ts     # Slash command handlers
├── tools.ts              # Tool definitions
├── utils.ts              # Utility functions
└── tests/                # Test files
```

## Configuration

The adapter uses the Cursor SDK and keeps local compatibility logic for resume/list/model behavior that ACP clients expect.

### Session Storage

Sessions are persisted under `~/.cursor-acp/sessions/` (or `$CURSOR_ACP_CONFIG_DIR/sessions/` if set). Each project has an encoded subdirectory; session history is stored as JSONL files with user and assistant messages for resume and replay.

## Cursor SDK setup

1. Create an API key at [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations).
2. Export it before starting the adapter:

```bash
export CURSOR_API_KEY="your-key"
```

Environment variables:

| Variable | Effect |
| -------- | ------ |
| `CURSOR_API_KEY` | Enables SDK-backed prompt execution and `/status` via `Cursor.me()` |
| `CURSOR_ACP_DEFAULT_MODE` | Fallback initial mode when the ACP client does not send one |
| `CURSOR_ACP_DEFAULT_MODEL` | Fallback initial model when the ACP client does not send one |
| `CURSOR_ACP_DEFAULT_THINKING` | Fallback initial thinking/reasoning level (e.g. `medium`, `high`) when the ACP client does not send one |
| `CURSOR_ACP_DEBUG_LOG=1` | Writes extra debug logs to `~/.cursor-acp/logs/debug.log` |

## Requirements

- [Zed](https://zed.dev)
- [Bun](https://bun.sh) on `PATH` (install, build, and runtime for `cursor-acp`)
- `CURSOR_API_KEY`
- Valid Cursor subscription

## Acknowledgments

This project is based on [claude-code-acp](https://github.com/zed-industries/claude-code-acp) by Zed Industries. Their work on the original Claude Code ACP adapter provided the architectural patterns and protocol implementation that made this project possible.

## License

Copyright 2026 Raphael Lüthy. Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full license text. Third-party attributions are listed in [NOTICE](NOTICE).
