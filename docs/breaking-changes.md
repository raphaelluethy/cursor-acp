# Breaking changes

The up-to-date v0.9.0 notice for upgrades involving the **Cursor SDK backend**, the **Auto Review default**, and **Yolo** (`yolo`) mode lives in the main project README:

**[Breaking changes (SDK backend and Auto Review default)](../README.md#breaking-changes-sdk-backend-and-auto-review-default)**

That section covers:

- migration of production prompt execution and authentication to `@cursor/sdk`
- shipping SDK Smart Auto Review as the default for new sessions
- ACP `default_config_options`, parameterized models, and the boolean Fast toggle
- fallback handling for `CURSOR_ACP_DEFAULT_MODE` / `CURSOR_ACP_DEFAULT_MODEL` / `CURSOR_ACP_DEFAULT_THINKING`
- removal of legacy Yolo aliases like `bypassPermissions` / `autoRunAllCommands`

Commit and PR attribution is now applied from the **global** Cursor CLI config only (`~/.cursor/cli-config.json` or `$CURSOR_CONFIG_DIR/cli-config.json`). Project `.cursor/cli.json` files are not used for those flags.

**[Commit and PR attribution](../README.md#commit-and-pr-attribution)**
