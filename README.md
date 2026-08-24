# cursor-acp

> **Why does this exist?** Cursor published their own ACP client ([docs](https://cursor.com/docs/cli/acp#ide-integrations)), but using it in Zed was rough as I somehow had to permit tool calls the whole time.

Disclaimer: I am not affiliated with Cursor or Zed. This project is a personal experiment and should not be considered an official product of either company. I am a big fan of both products and wanted to combine what I like with both of them: An amazing editor and a great AI coding agent (and composer-1, holy this model flies xD).

An [Agent Client Protocol (ACP)](https://github.com/agentclientprotocol/agent-client-protocol) adapter for the [Cursor SDK](https://cursor.com/docs/sdk/typescript), enabling Cursor's coding agent in [Zed](https://zed.dev) and other ACP-compatible clients.

## About

This is an `ai-assisted` personal project aimed at bringing Cursor's agent into Zed. Prompt execution uses `@cursor/sdk`; the adapter adds ACP session persistence, history replay, model and mode controls, and Zed-friendly configuration options.

**Based on [claude-code-acp](https://github.com/zed-industries/claude-code-acp)** by Zed Industries - the original ACP adapter for Claude Code that served as the architectural foundation for this project.

## Features

### Cursor SDK backend

- **Smart Auto Review by default**: New sessions create local SDK agents with `local.autoReview: true`. Cursor's classifier runs approved calls and fails closed on the rest.
- **ACP permission fallback**: A call stopped by Auto Review is surfaced to the client. “Allow once” retries that turn with Auto Review disabled; “Always allow” switches the session to Yolo.
- **Correct SDK mode lifecycle**: Auto Review is an agent-level SDK option. Switching review policy closes and resumes the same SDK agent with the new policy; the SDK's unrelated crash-recovery `force` flag is never used as an approval bypass.
- **Model parameters**: Canonical SDK model IDs, thinking levels, fast values, and variants flow into SDK model selections.
- **MCP and images**: ACP-provided stdio/HTTP/SSE MCP servers and image chunks are forwarded to the SDK.
- **Agent, Plan, and Ask**: Plan uses the SDK's `plan` send mode. Ask creates a no-tools SDK agent.

### Wrapper compatibility

- **ACP session lifecycle**: Supports `new`, `resume`, and `fork` (best-effort) session operations
- **Session persistence & history replay**: Stores visible history locally and replays it on resume/load
- **Session listing**: Lists past local sessions with optional cwd filtering and pagination
- **Model listing and selection**: `/model` and ACP config options use the SDK catalog.
- **ACP 1.4 controls**: Clients that advertise boolean config support render Fast as a toggle; older clients receive a select fallback. Thinking remains a model-specific selector.
- **SDK authentication**: `/login`, `/logout`, `/status`, `CURSOR_API_KEY`, and ACP terminal authentication use Cursor SDK credentials. Browser login is stored under `~/.cursor/sdk/auth.json`.
- **Optional Yolo mode** (`yolo`): Disables Auto Review for unrestricted local SDK execution.

### Known limitations

- Cursor SDK authentication is separate from `cursor-agent` CLI authentication. Run `/login`, `cursor-acp login`, or set `CURSOR_API_KEY`.
- The SDK exposes no interactive per-tool approval callback. ACP approval therefore retries the complete turn without Auto Review; work completed before the blocked call may be repeated.
- Auto Review reduces confirmation noise but is not a security boundary. Use sandboxing and normal least-privilege practices for untrusted workspaces.
- `debug` mode is not exposed.

## Breaking changes (SDK backend and Auto Review default)

Version 0.9.0 moves prompt turns to `@cursor/sdk` instead of `cursor-agent --print`. SDK authentication is separate from Cursor CLI authentication, and **Auto Review is the shipped default for new sessions**.

### Configuration defaults

Use ACP `default_config_options` with Zed versions that support ACP config defaults. The adapter still accepts legacy inline defaults and reads `CURSOR_ACP_DEFAULT_MODE`, `CURSOR_ACP_DEFAULT_MODEL`, and `CURSOR_ACP_DEFAULT_THINKING` as fallbacks.

### Commit and PR attribution

cursor-acp honors Cursor's [global CLI attribution settings](https://cursor.com/docs/cli/reference/configuration#optional-fields). To disable both commit trailers and PR attribution, put this in `~/.cursor/cli-config.json` (or `$CURSOR_CONFIG_DIR/cli-config.json`):

```json
{
  "attribution": {
    "attributeCommitsToAgent": false,
    "attributePRsToAgent": false
  }
}
```

Attribution is global-only; Cursor project `.cursor/cli.json` files support permissions, not attribution. The pinned SDK currently needs a guarded install-time compatibility patch for these two settings, so dependency installation fails instead of silently ignoring them if Cursor changes the relevant runtime code.

### Legacy Yolo mode name aliases removed

Older builds accepted `bypassPermissions` and `autoRunAllCommands` as synonyms for **`yolo`** in `default_mode` and in `/mode`. Those names are **no longer accepted**—use **`yolo`** (or pick **Yolo** in the client).

### Auto-review mode (`auto-review`)

- **What it is**: Cursor SDK Smart Auto Review, enabled with `local.autoReview: true` on local agents.
- **Default**: The adapter starts in `auto-review` unless the client or environment explicitly chooses another mode. Legacy `default` values normalize to `auto-review`.
- **Remaining prompts**: Calls the classifier stops are offered to the ACP client. Choosing “Always allow” upgrades the session to Yolo.
- **What it is not**: Not Yolo, Bugbot/PR review, or a sandbox/security boundary.

### Yolo mode (`yolo`)

- **What it does**: Creates/resumes the local SDK agent with Auto Review disabled. This is the SDK's headless “run everything” behavior.
- **Configuration**: Set `default_config_options.mode` to `yolo` or choose Yolo in the mode picker. Do not use removed aliases such as `bypassPermissions` or `autoRunAllCommands`.

The same notice is linked from [`docs/breaking-changes.md`](docs/breaking-changes.md).

## Slash Commands

| Command   | Description                            |
| --------- | -------------------------------------- |
| `/help`   | Show available commands                |
| `/model`  | Switch or display the current model    |
| `/mode`   | Switch or display the current mode     |
| `/status` | Show authentication and session status |
| `/login`  | Authenticate with Cursor               |
| `/logout` | Sign out of Cursor                     |

Project and user slash commands/skills discovered by the adapter are added to the ACP command list.

## Installation

```bash
nub install
nub run build
```

This compiles the project and produces the `cursor-acp` binary entry point at `./dist/index.js`.

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
nub run start
```

Or use the binary:

```bash
cursor-acp
```

### Authenticate

Authenticate the Cursor SDK in a browser before starting a session:

```bash
cursor-acp login
```

Run `cursor-acp logout` to remove the stored SDK credential. If `CURSOR_API_KEY` is set, it remains active until removed from the adapter process environment.

### Configuring Zed

Open your Zed settings file via the Command Palette (`zed: open settings`) and add a custom agent server entry under `agent_servers`:

```json
{
  "agent_servers": {
    "Cursor": {
      "type": "custom",
      "command": "cursor-acp",
      "args": [],
      "default_config_options": {
        "mode": "auto-review",
        "fast": false
      }
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
      "default_config_options": {
        "mode": "auto-review",
        "fast": false
      }
    }
  }
}
```

#### Default mode, model, Fast, and Thinking

Zed versions with ACP config defaults pass initial controls through `default_config_options`. When the client also advertises boolean config support, Fast appears as a native toggle in the agent panel:

```json
{
  "agent_servers": {
    "Cursor": {
      "type": "custom",
      "command": "cursor-acp",
      "args": [],
      "default_config_options": {
        "mode": "auto-review",
        "model": "composer-2.5",
        "fast": false,
        "thinking": "high"
      }
    }
  }
}
```

- `mode` — one of `auto-review`, `yolo`, `plan`, or `ask`. Omit it to use the shipped `auto-review` default; legacy `default` values still work as an alias.
- `model` — optional canonical model ID from the Cursor SDK catalog.
- `fast` — boolean toggle when the selected model advertises a `fast` parameter.
- `thinking` — model-specific reasoning value such as `none`, `low`, `medium`, `high`, `xhigh`, or `max`.

Legacy Zed fields (`default_mode`, `default_model`, `default_fast`, and `default_thinking`) remain accepted for compatibility. There is no adapter-specific config file. Environment fallbacks are `CURSOR_ACP_DEFAULT_MODE`, `CURSOR_ACP_DEFAULT_MODEL`, and `CURSOR_ACP_DEFAULT_THINKING`.

The mode picker lists **Auto-review**, **Yolo**, **Ask**, and **Plan**. Model-specific **Fast** and **Thinking** controls appear when the SDK catalog advertises those parameters. Clients that advertise boolean config support receive Fast as a toggle; other clients receive an On/Off select.

### Using in Zed

1. Open the Agent Panel with `Cmd+?` (macOS) or `Ctrl+?` (Linux)
2. Click the `+` button in the top right and select **Cursor**
3. On first use, select the Cursor SDK login method or run `/login`
4. Auto Review is already the default. Choose **Yolo** only when you explicitly want unrestricted local tool execution.

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
nub run dev
```

### Testing

```bash
nub run test           # Run tests in watch mode
nub run test:run       # Run tests once
```

### Linting & Formatting

```bash
nub run lint          # Check with Oxlint
nub run lint:fix      # Apply safe Oxlint fixes
nub run format        # Format with Oxfmt
nub run format:check  # Verify formatting without writing files
nub run check         # Run lint and format checks
```

Oxlint and Oxfmt use their repository-level configurations. Source indentation uses tabs rendered at a width of four spaces, as configured in `.oxfmtrc.json` and `.editorconfig`.

## Migration Notes

- See **Breaking changes (SDK backend and Auto Review default)** when upgrading from the CLI-backed adapter.
- `auto-review`, `yolo`, `ask`, and `plan` are the advertised modes
- `default`, `acceptEdits`, `agent`, and `autoReview` are accepted as compatibility aliases for **`auto-review`**. For Yolo, use **`yolo`**—`bypassPermissions` and `autoRunAllCommands` are no longer accepted (see **Legacy Yolo mode name aliases removed**)
- `debug` is not exposed
- SDK user settings are loaded from Cursor's user setting source.

## Project Structure

```
src/
├── index.ts              # CLI entry point
├── lib.ts                # Library exports
├── cursor-acp-agent.ts   # ACP lifecycle, persistence, and permissions
├── cursor-runner.ts      # Prompt execution interface
├── cursor-sdk-runner.ts  # Cursor SDK implementation
├── cursor-sdk-event-adapter.ts # SDK-to-ACP event compatibility
├── prompt-conversion.ts  # ACP text, context, and image conversion
├── auth.ts               # Cursor SDK authentication
├── settings.ts           # Mode ids and normalization helpers
├── session-storage.ts    # Session persistence and history replay
├── slash-commands.ts     # Slash command handlers
├── tools.ts              # Tool definitions
├── utils.ts              # Utility functions
└── tests/                # Test files
```

## Configuration

The adapter uses local Cursor SDK agents and keeps wrapper-level compatibility logic for ACP resume, list, and visible-history replay.

### Session Storage

Sessions are persisted under `~/.cursor-acp/sessions/` (or `$CURSOR_ACP_CONFIG_DIR/sessions/` if set). Each project has an encoded subdirectory; session history is stored as JSONL files with user and assistant messages for resume and replay.

## Requirements

- [Zed](https://zed.dev)
- Node.js 22.13+ (required by the SDK's default local SQLite store)
- [Nub](https://nubjs.com/docs) (for package management and scripts)
- Valid Cursor subscription

## Acknowledgments

This project is based on [claude-code-acp](https://github.com/zed-industries/claude-code-acp) by Zed Industries. Their work on the original Claude Code ACP adapter provided the architectural patterns and protocol implementation that made this project possible.

## License

Copyright 2026 Raphael Lüthy. Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full license text. Third-party attributions are listed in [NOTICE](NOTICE).
