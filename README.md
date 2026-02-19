# cursor-acp

Disclaimer: I am not affiliated with Cursor or Zed. This project is a personal experiment and should not be considered an official product of either company. I am a big fan of both products and wanted to combine what I like with both of them: An amazing editor and a great AI coding agent (and composer-1, holy this model flies xD).

An [Agent Client Protocol (ACP)](https://github.com/AnyContext/agent-client-protocol) adapter for [Cursor](https://cursor.sh) Agent CLI, enabling Cursor's powerful AI coding assistant to be used within the [Zed](https://zed.dev) editor.

## About

This is an `ai-assisted` personal project aimed at bringing a great AI coding agent into the Zed editor. It wraps the Cursor Agent CLI and exposes it via the ACP protocol, allowing Zed (and other ACP-compatible clients) to leverage Cursor's capabilities.

**Based on [claude-code-acp](https://github.com/zed-industries/claude-code-acp)** by Zed Industries - the original ACP adapter for Claude Code that served as the architectural foundation for this project.

## Features

- **ACP Session Lifecycle**: Supports `new`, `resume`, and `fork` (best-effort) session operations
- **Session Persistence & History**: Conversation history is persisted to disk; when resuming a session, the full history is replayed so the client sees previous messages
- **Session Listing**: List past sessions (with optional cwd filter and pagination) for quick resume
- **Model & Mode Switching**: Dynamically change the underlying model and operation mode
- **Authentication**: Login/logout/status management via Cursor CLI
- **File Mentions**: Converts `@` file/resource mentions to the appropriate format
- **Tool Call Streaming**: Real-time ACP tool updates during execution
- **Plan Updates**: TODO updates mapped to ACP plans
- **Slash Commands**: Built-in adapter commands plus workspace/global custom slash commands

## Slash Commands

| Command   | Description                            |
| --------- | -------------------------------------- |
| `/help`   | Show available commands                |
| `/model`  | Switch or display the current model    |
| `/mode`   | Switch or display the current mode     |
| `/status` | Show authentication and session status |
| `/login`  | Authenticate with Cursor               |
| `/logout` | Sign out of Cursor                     |

Custom slash commands are loaded from:

- `<workspace>/.cursor/commands/*.md`
- `~/.cursor/commands/*.md`

If both locations define the same command name, the workspace command wins.

## Skills

Custom skills are loaded from:

- `<workspace>/.cursor/skills/**/skill.md`
- `~/.agents/skills/**/skill.md`

If multiple locations define the same skill name, the workspace skill wins.

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

#### Environment Variables

You can optionally set default mode and model via environment variables in the `"env"` object:

- `CURSOR_ACP_DEFAULT_MODE` — one of `default`, `acceptEdits`, `plan`, `ask`, `bypassPermissions`
- `CURSOR_ACP_DEFAULT_MODEL` — a model ID string (e.g. the model ID shown by `/model`)

Example with defaults configured:

```json
{
  "agent_servers": {
    "Cursor": {
      "type": "custom",
      "command": "cursor-acp",
      "args": [],
      "env": {
        "CURSOR_ACP_DEFAULT_MODE": "bypassPermissions"
      }
    }
  }
}
```

### Using in Zed

1. Open the Agent Panel with `Cmd+?` (macOS) or `Ctrl+?` (Linux)
2. Click the `+` button in the top right and select **Cursor**
3. On first use, run the `/login` slash command to authenticate with Cursor

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

## Project Structure

```
src/
├── index.ts              # CLI entry point
├── lib.ts                # Library exports
├── cursor-acp-agent.ts   # Main ACP agent implementation
├── cursor-cli-runner.ts  # Cursor CLI process management
├── cursor-event-mapper.ts# Maps Cursor events to ACP events
├── prompt-conversion.ts  # Converts ACP prompts to Cursor format
├── auth.ts               # Authentication handling
├── settings.ts           # Configuration management
├── session-storage.ts    # Session persistence and history replay
├── slash-commands.ts     # Slash command handlers
├── tools.ts              # Tool definitions
├── utils.ts              # Utility functions
└── tests/                # Test files
```

## Configuration

The adapter uses Cursor CLI with `--print --output-format stream-json` flags for streaming JSON output that gets mapped to ACP events.

### Session Storage

Sessions are persisted under `~/.cursor-acp/sessions/` (or `$CURSOR_ACP_CONFIG_DIR/sessions/` if set). Each project has an encoded subdirectory; session history is stored as JSONL files with user and assistant messages for resume and replay.

## Requirements

- [Zed](https://zed.dev) 
- Node.js 18+
- [Bun](https://bun.sh) (for package management and scripts)
- Cursor CLI installed and available in PATH
- Valid Cursor authentication

## Acknowledgments

This project is based on [claude-code-acp](https://github.com/zed-industries/claude-code-acp) by Zed Industries. Their work on the original Claude Code ACP adapter provided the architectural patterns and protocol implementation that made this project possible.

## License

Copyright 2026 Raphael Lüthy. Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full license text. Third-party attributions are listed in [NOTICE](NOTICE).
