# cursor-acp

An [Agent Client Protocol (ACP)](https://github.com/AnyContext/agent-client-protocol) adapter for [Cursor](https://cursor.sh) Agent CLI, enabling Cursor's powerful AI coding assistant to be used within the [Zed](https://zed.dev) editor.

## About

This is an `ai-assisted` personal project aimed at bringing a great AI coding agent into the Zed editor. It wraps the Cursor Agent CLI and exposes it via the ACP protocol, allowing Zed (and other ACP-compatible clients) to leverage Cursor's capabilities.

**Based on [claude-code-acp](https://github.com/zed-industries/claude-code-acp)** by Zed Industries - the original ACP adapter for Claude Code that served as the architectural foundation for this project.

## Features

- **ACP Session Lifecycle**: Supports `new`, `resume`, and `fork` (best-effort) session operations
- **Model & Mode Switching**: Dynamically change the underlying model and operation mode
- **Authentication**: Login/logout/status management via Cursor CLI
- **File Mentions**: Converts `@` file/resource mentions to the appropriate format
- **Tool Call Streaming**: Real-time ACP tool updates during execution
- **Plan Updates**: TODO updates mapped to ACP plans
- **Slash Commands**: Built-in adapter commands for control and configuration

## Slash Commands

| Command   | Description                            |
| --------- | -------------------------------------- |
| `/help`   | Show available commands                |
| `/model`  | Switch or display the current model    |
| `/mode`   | Switch or display the current mode     |
| `/status` | Show authentication and session status |
| `/login`  | Authenticate with Cursor               |
| `/logout` | Sign out of Cursor                     |

## Installation

```bash
npm install
npm run build
```

## Usage

### Run directly

```bash
npm start
```

Or use the binary:

```bash
cursor-acp
```

### Development

```bash
npm run dev
```

### Testing

```bash
npm test           # Run tests in watch mode
npm run test:run   # Run tests once
```

### Linting & Formatting

```bash
npm run lint       # Check for linting issues
npm run lint:fix   # Auto-fix linting issues
npm run format     # Format code with Prettier
npm run check      # Run lint and format checks
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
├── slash-commands.ts     # Slash command handlers
├── tools.ts              # Tool definitions
├── utils.ts              # Utility functions
└── tests/                # Test files
```

## Configuration

The adapter uses Cursor CLI with `--print --output-format stream-json` flags for streaming JSON output that gets mapped to ACP events.

## Requirements

- Node.js 18+
- Cursor CLI installed and available in PATH
- Valid Cursor authentication

## Acknowledgments

This project is based on [claude-code-acp](https://github.com/zed-industries/claude-code-acp) by Zed Industries. Their work on the original Claude Code ACP adapter provided the architectural patterns and protocol implementation that made this project possible.

## License

Apache-2.0 - See [LICENSE](LICENSE) for details.
