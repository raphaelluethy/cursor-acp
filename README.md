# cursor-acp

> **Why does this exist?** Cursor published their own ACP client ([docs](https://cursor.com/docs/cli/acp#ide-integrations)), but using it in Zed was rough as I somehow had to permit tool calls the whole time.

Disclaimer: I am not affiliated with Cursor or Zed. This project is a personal experiment and should not be considered an official product of either company. I am a big fan of both products and wanted to combine what I like with both of them: An amazing editor and a great AI coding agent (and composer-1, holy this model flies xD).

An [Agent Client Protocol (ACP)](https://github.com/agentclientprotocol/agent-client-protocol) adapter for [Cursor](https://cursor.com) Agent CLI, enabling Cursor's AI coding assistant to be used within [Zed](https://zed.dev) and other ACP-compatible clients.

## About

This is an `ai-assisted` personal project aimed at bringing Cursor's agent into Zed. It acts as a **wrapper around native `agent acp`**, auto-approving tool calls when you opt in and preserving compatibility features that the current native ACP server does not expose yet.

**Based on [claude-code-acp](https://github.com/zed-industries/claude-code-acp)** by Zed Industries - the original ACP adapter for Claude Code that served as the architectural foundation for this project.

## Features

### Native-backed

- **Native ACP backend**: Uses `agent acp` instead of the older `agent --print --output-format stream-json` wrapper path
- **Tool and message streaming**: Forwards native ACP `session/update` notifications to the client
- **Cursor extension RPCs**: Forwards native `cursor/*` extension methods and notifications (e.g. `cursor/ask_question`, `cursor/update_todos`) to the outer ACP client when supported
- **Cursor commands and skills**: Relies on native ACP `available_commands_update` for Cursor/user commands and skills
- **Native command precedence**: When Cursor advertises a slash command, the adapter forwards that command to native ACP instead of intercepting it locally
- **Mode switching**: Maps wrapper modes to native `agent`, `ask`, and `plan`

### Wrapper compatibility

- **ACP session lifecycle**: Supports `new`, `resume`, and `fork` (best-effort) session operations
- **Session persistence & history replay**: Stores visible history locally and replays it on resume/load
- **Session listing**: Lists past local sessions with optional cwd filtering and pagination
- **Model listing and best-effort model selection**: Keeps `/model` support while native ACP has no stable model API
- **Authentication helpers**: `/login`, `/logout`, `/status`, plus terminal-auth metadata for ACP clients that support it
- **Prompt flattening for ACP clients**: Keeps embedded context and image prompts working by converting them to text before forwarding to native ACP
- **Optional Yolo mode** (`yolo`): Auto-approves native ACP permission requests when explicitly selected

### Known limitations

- Native Cursor ACP on the currently validated CLI does **not** expose `session/list`, `session/resume`, or `session/set_model`
- Resuming after restarting `cursor-acp` uses native `session/load` when a stored `backendSessionId` is available; if that fails, the adapter starts a **new** native session and replays local JSONL so visible history is preserved
- `debug` mode is intentionally not exposed in this phase

## Breaking changes (native ACP & Yolo)

If you used an older `cursor-acp` that drove Cursor through the legacy **`agent --print --output-format stream-json`** path, upgrading changes behavior in ways that are easy to mistake for “bugs” unless you know what moved:

### Native `agent acp` backend

- **Execution model**: The adapter now spawns **native `agent acp`** and speaks ACP to Cursor’s server. Session traffic, slash-command routing, and tool permission flows follow **native ACP**, not the previous wrapper-only protocol.
- **Slash commands**: If Cursor advertises a command name that matches a built-in wrapper command (for example `/model`), the **native command wins** and is forwarded to the backend; the wrapper no longer always intercepts those names.
- **Permissions**: Tool and action approval is mediated through **native `requestPermission`** notifications. The adapter translates them to the outer ACP client unless you opt into Yolo (below).
- **Resume / listing**: Resume uses native **`session/load`** when a stored backend session id is available; native Cursor ACP still does not expose everything the outer protocol can represent (see **Known limitations**). Expect differences versus the old stream-json session lifecycle.

### Yolo mode (`yolo`)

- **What it does now**: **Yolo** only changes how the adapter answers **native ACP permission requests**—it auto-selects an allow-style option (preferring `allow_always`, then `allow_once`, then another allow). It does **not** introduce a separate native Cursor mode: both **Default** and **Yolo** map to native **`agent`**; the difference is whether permissions are surfaced to your client or approved inside the adapter.
- **Why that can break expectations**: If you relied on the old wrapper’s auto-approval semantics (or on names like `bypassPermissions` / `autoRunAllCommands`) as identical to “unrestricted agent” in the legacy path, behavior may differ because approvals are now tied to **native permission options** and to the **ACP permission** channel.
- **Configuration**: Aliases such as `bypassPermissions` → `yolo` remain supported; see **Migration Notes**. You must still set `default_mode` / `CURSOR_ACP_DEFAULT_MODE` to `yolo` (or pick **Yolo** in the client) to get automatic approval.

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

Other Cursor commands and skills are forwarded from native `agent acp` via `available_commands_update`.
If a native Cursor command collides with one of the wrapper commands above, the native command takes precedence.

## Installation

```bash
bun install
bun run build
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
      "env": {}
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
      "env": {}
    }
  }
}
```

#### Default mode and model

**Config file (recommended):** create `~/.cursor-acp/config.json` (or `$CURSOR_ACP_CONFIG_DIR/config.json`):

```json
{
  "default_mode": "yolo",
  "default_model": "your-model-id"
}
```

- `default_mode` — one of `default`, `yolo`, `plan`, or `ask` (legacy aliases: `acceptEdits` → `default`, `bypassPermissions` / `autoRunAllCommands` → `yolo`)
- `default_model` — optional model ID (e.g. the model ID shown by `/model`)

Omit keys you do not need. Environment variables below override the file when set.

The mode picker in Zed (and other ACP clients) lists **Default**, **Yolo**, **Ask**, and **Plan** — including **Yolo**, which is implemented only in this adapter (Cursor’s native session still uses its usual Agent/Plan/Ask wiring under the hood).

#### Environment Variables

You can alternatively set defaults via environment variables in the `"env"` object (or your shell):

- `CURSOR_ACP_DEFAULT_MODE` — same values as `default_mode` in the config file
- `CURSOR_ACP_DEFAULT_MODEL` — same as `default_model` in the config file

Example using env only:

```json
{
  "agent_servers": {
    "Cursor": {
      "type": "custom",
      "command": "cursor-acp",
      "args": [],
      "env": {
        "CURSOR_ACP_DEFAULT_MODE": "yolo"
      }
    }
  }
}
```

### Using in Zed

1. Open the Agent Panel with `Cmd+?` (macOS) or `Ctrl+?` (Linux)
2. Click the `+` button in the top right and select **Cursor**
3. On first use, run the `/login` slash command to authenticate with Cursor
4. The default mode is `default`; if you want tool execution without repeated prompts, set `"default_mode": "yolo"` in `~/.cursor-acp/config.json` or `CURSOR_ACP_DEFAULT_MODE=yolo`

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

- See **Breaking changes (native ACP & Yolo)** for semantic and protocol differences when upgrading from the legacy stream-json wrapper.
- `default`, `yolo`, `ask`, and `plan` are the advertised modes
- `acceptEdits`, `bypassPermissions`, and `autoRunAllCommands` are deprecated aliases (still accepted; map to `default` / `yolo` as documented under **Default mode and model**)
- `debug` is not exposed
- Custom commands and skills are forwarded from native `agent acp`

## Project Structure

```
src/
├── index.ts              # CLI entry point
├── lib.ts                # Library exports
├── cursor-acp-agent.ts   # Outer ACP agent + compatibility layer
├── cursor-native-acp-client.ts # Native `agent acp` bridge
├── cursor-cli-runner.ts  # Cursor CLI helpers (model listing)
├── prompt-conversion.ts  # Flattens ACP prompts for native ACP forwarding
├── auth.ts               # Authentication handling
├── settings.ts           # Configuration management
├── session-storage.ts    # Session persistence and history replay
├── slash-commands.ts     # Slash command handlers
├── tools.ts              # Tool definitions
├── utils.ts              # Utility functions
└── tests/                # Test files
```

## Configuration

The adapter now uses `agent acp` as its execution backend and keeps local compatibility logic for resume/list/model behavior that native ACP does not currently expose.

### Session Storage

Sessions are persisted under `~/.cursor-acp/sessions/` (or `$CURSOR_ACP_CONFIG_DIR/sessions/` if set). Each project has an encoded subdirectory; session history is stored as JSONL files with user and assistant messages for resume and replay.

## Requirements

- [Zed](https://zed.dev)
- Node.js 25.6.1+
- [Bun](https://bun.sh) (for package management and scripts)
- Cursor CLI installed and available in PATH
- Valid Cursor subscription

## Acknowledgments

This project is based on [claude-code-acp](https://github.com/zed-industries/claude-code-acp) by Zed Industries. Their work on the original Claude Code ACP adapter provided the architectural patterns and protocol implementation that made this project possible.

## License

Copyright 2026 Raphael Lüthy. Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full license text. Third-party attributions are listed in [NOTICE](NOTICE).
