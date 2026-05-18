# Breaking changes

The up-to-date notice for upgrades involving the current **hybrid backend** and **Yolo** (`yolo`) mode lives in the main project README:

**[Breaking changes (hybrid backend & Yolo)](../README.md#breaking-changes-hybrid-backend--yolo)**

That section covers:

- the return to the legacy **`cursor-agent --print --output-format stream-json`** prompt path for accurate shell command display
- continued use of native **`cursor-agent acp`** for session compatibility features
- fallback handling for `CURSOR_ACP_DEFAULT_MODE` / `CURSOR_ACP_DEFAULT_MODEL`
- removal of legacy Yolo aliases like `bypassPermissions` / `autoRunAllCommands`
