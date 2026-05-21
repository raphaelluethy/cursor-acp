# Migrating to 1.0.0 (Agent CLI → SDK)

Version **1.0.0** replaces all `cursor-agent` subprocess integration with [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk). This is a **major breaking release**. Upgrade if you want the SDK-backed adapter; stay on **0.7.x** if you still rely on the hybrid CLI backend.

The README summarizes user-facing changes in [Breaking changes (SDK-only backend & Yolo)](../README.md#breaking-changes-sdk-only-backend--yolo). This document is the full migration guide.

## Upgrade checklist

1. **Install or build 1.0.0** and ensure [Bun](https://bun.sh) is on `PATH` (required for install, build, and runtime).
2. **Create a Cursor API key** at [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations).
3. **Export `CURSOR_API_KEY`** in the environment that launches `cursor-acp` (for example the shell or process manager Zed uses).
4. **Remove CLI-only assumptions** from your setup: you no longer need `cursor-agent` installed or logged in for prompt execution.
5. **Update Zed (or other ACP client) agent config:**
   - Set `default_mode` to `default`, `yolo`, or `plan` (not `ask`, `bypassPermissions`, or `autoRunAllCommands`).
   - Set `default_model` to an SDK model id (for example `composer-2`, `gpt-5.5`, or `auto`).
   - Optionally set `default_thinking` when your model exposes `reasoning`, `effort`, or `thinking` parameters.
6. **Re-select fast mode in the client** when your model supports it. Fast mode is now a dynamic config option (`fast` parameter), not a separate model id or bracket suffix.
7. **Expect new Yolo semantics** if you used Yolo before: see [Yolo mode](#yolo-mode-yolo) below.
8. **Resume behavior:** visible history is replayed from local JSONL under `~/.cursor-acp/sessions/`. SDK agent ids are resumed when stored; there is no native `session/load` against `cursor-agent acp`.

## What changed at a glance

| Area | 0.x (CLI / hybrid) | 1.0.0 (SDK-only) |
| ---- | ------------------ | ---------------- |
| Backend | `cursor-agent acp` + legacy stream-json prompt path | `@cursor/sdk` only |
| Auth | CLI login / terminal-auth metadata | `CURSOR_API_KEY` required; `/status` uses `Cursor.me()` |
| Prompt execution | Subprocess `--print --output-format stream-json` | `CursorSdkRunner` + SDK agents |
| Models | Wrapper catalog + native gaps | `Cursor.models.list()` SDK catalog |
| Fast models | Separate ids (e.g. `composer-2-fast`) or `model[fast=true]` syntax | SDK `fast` parameter as ACP config option |
| Thinking | Limited / model-specific | Dynamic config option; id is `reasoning`, `effort`, or `thinking` |
| Modes | `default`, `yolo`, `ask`, `plan` (+ legacy aliases) | `default`, `yolo`, `plan` only |
| Yolo | Auto-answers native ACP permission prompts | Retries rejected tools with forced local SDK execution |
| Slash commands | Native commands could override wrapper commands | Wrapper handles built-ins locally; custom commands from local files |
| Resume | Native `session/load` when `backendSessionId` existed | Local JSONL replay + SDK agent resume |
| Extension RPCs | Forwards `cursor/*` to ACP client | Not available |
| Runtime | Node.js + `cursor-agent` CLI | Bun + `@cursor/sdk` (+ sqlite3 for agent persistence) |

## Authentication

### Before (0.x)

Authentication went through the Cursor Agent CLI. `/login`, `/logout`, and `/status` reflected CLI session state. Some ACP clients could use terminal-auth metadata.

### After (1.0.0)

Authentication is API-key based:

```bash
export CURSOR_API_KEY="your-key"
```

- `/login` — prints setup instructions (does not perform interactive login).
- `/logout` — explains how to unset `CURSOR_API_KEY`.
- `/status` — calls `Cursor.me()` to verify the key.

Ensure the process that starts `cursor-acp` inherits `CURSOR_API_KEY`. Setting it only in an interactive shell is not enough if Zed launches the adapter without that environment.

## Modes

### Advertised modes

| Mode | Behavior |
| ---- | -------- |
| `default` | Standard SDK agent send; tool permissions follow the ACP client |
| `yolo` | Retries rejected tool calls with forced local execution when the user chooses always-allow |
| `plan` | SDK plan mode |

### Legacy aliases still accepted

| Legacy name | Maps to |
| ----------- | ------- |
| `acceptEdits` | `default` |
| `ask` | `default` |
| `agent` | `default` |

### Removed mode names (error if used)

- `bypassPermissions` — use **`yolo`**
- `autoRunAllCommands` — use **`yolo`**

**Ask mode** is no longer advertised. `@cursor/sdk` does not expose Ask mode; the separate Ask path was removed.

## Yolo mode (`yolo`)

### Before (0.x)

Yolo auto-selected allow-style answers to **native ACP permission requests** (`allow_always`, `allow_once`, etc.). Both Default and Yolo mapped to native **`agent`**; Yolo only changed permission handling.

### After (1.0.0)

Yolo retries **rejected tool calls** with forced local SDK execution when the user approves always. There is no native ACP permission channel because the CLI bridge is gone.

If you relied on Yolo as “never prompt me for permissions” in the old hybrid backend, re-test tool execution after upgrading. Set `"default_mode": "yolo"` on your ACP client agent entry for automatic approval behavior.

## Model and parameter selection

### Model ids

Use SDK catalog ids only. Examples: `composer-2`, `gpt-5.5`, `auto`.

- The SDK model id `default` is normalized to **`auto`** in the adapter.
- Bracket syntax such as `composer-2[fast=true]` is **not** accepted.
- Separate fast variant model ids (for example `composer-2-fast`) are **not** used; configure fast mode through the **`fast`** config option instead.

### Fast parameter

When `Cursor.models.list()` exposes a `fast` parameter for the selected model, the adapter adds a dynamic ACP config option. Pick fast mode in the client session UI rather than encoding it in the model id.

### Thought level

When the model exposes `reasoning`, `effort`, or `thinking` parameters, the adapter exposes a matching ACP config option in the `thought_level` category. The config option **id matches the SDK parameter id** (not a hardcoded `thinking` id).

Configure via:

- ACP client fields: `default_thinking`, `default_thinking_level`, or `thinking`
- Environment fallback: `CURSOR_ACP_DEFAULT_THINKING`

### `/model` slash command

`/model` lists SDK models and accepts SDK model ids. Parameter defaults come from model variant metadata.

## Sessions and resume

Local session storage is unchanged in location: `~/.cursor-acp/sessions/` (or `$CURSOR_ACP_CONFIG_DIR/sessions/`).

What changed:

- **No native `session/load`:** resume replays stored visible history from JSONL and reattaches to a stored SDK agent id when available.
- **Listing:** session list remains local; filtering and pagination behavior is preserved.
- **Fork:** best-effort, same as before.

After restarting `cursor-acp`, open an existing session from the client to replay history. If the SDK agent id is still valid, the agent continues; otherwise a new SDK agent is created with replayed messages.

## Removed features

The following 0.x capabilities are **not** available in 1.0.0:

- Native `cursor-agent acp` bridge and hybrid backend switching
- Cursor extension RPC forwarding (`cursor/ask_question`, `cursor/update_todos`, etc.)
- Native command precedence (wrapper no longer forwards `/model` etc. to the CLI when Cursor advertised them)
- Turn-closing markdown recap when a turn ended with tools but no assistant text
- CLI terminal-auth metadata
- **`debug`** wrapper mode

Custom commands and skills are still supported where resolved from local command/skill files.

## Configuration defaults

Prefer ACP client defaults on the custom agent entry (Zed `agent_servers`):

```json
{
  "agent_servers": {
    "Cursor": {
      "type": "custom",
      "command": "cursor-acp",
      "args": [],
      "default_mode": "yolo",
      "default_model": "composer-2",
      "default_thinking": "medium"
    }
  }
}
```

Environment fallbacks when the client does not send defaults:

| Variable | Purpose |
| -------- | ------- |
| `CURSOR_ACP_DEFAULT_MODE` | Initial mode |
| `CURSOR_ACP_DEFAULT_MODEL` | Initial model id |
| `CURSOR_ACP_DEFAULT_THINKING` | Initial thought/reasoning level |

There is no separate adapter config file for these values.

## Troubleshooting

| Symptom | Likely cause | Fix |
| ------- | ------------ | --- |
| Prompt fails immediately | Missing or invalid API key | Set `CURSOR_API_KEY`; run `/status` |
| `Invalid mode` for Yolo | Legacy alias in config | Use `yolo`, not `bypassPermissions` |
| Model not found | Old model id or bracket syntax | Use SDK id from `/model` or client picker |
| No fast variant | Expecting `composer-2-fast` id | Enable fast via session config option |
| Empty history after upgrade | Old native session id | Expected; local JSONL replay still works for stored wrapper sessions |
| Build/install fails on sqlite3 | Native dependency of `@cursor/sdk` | Run `bun install` (postinstall rebuilds sqlite3) |

Enable adapter debug logging:

```bash
export CURSOR_ACP_DEBUG_LOG=1
```

Logs are written to `~/.cursor-acp/logs/debug.log`. In Zed, use `dev: open acp logs` for protocol traces.

## Architecture reference

For implementation details of the SDK-only adapter, see [`cursor-sdk-acp-blueprint.md`](cursor-sdk-acp-blueprint.md).

## Staying on 0.x

If you depend on native ACP extension RPCs, CLI login flows, or the hybrid stream-json prompt path, pin **0.7.2** (or your current 0.x version) until you can adopt the SDK requirements above.
