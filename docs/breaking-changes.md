# Breaking changes

The up-to-date notice for upgrades involving the current **SDK-only backend** and **Yolo** (`yolo`) mode lives in the main project README:

**[Breaking changes (SDK-only backend & Yolo)](../README.md#breaking-changes-sdk-only-backend--yolo)**

That section covers:

- removal of all Cursor command subprocess integration
- SDK-only prompt execution, model listing, and authentication
- fallback handling for `CURSOR_ACP_DEFAULT_MODE` / `CURSOR_ACP_DEFAULT_MODEL`
- removal of legacy Yolo aliases like `bypassPermissions` / `autoRunAllCommands`
- removal of the advertised Ask mode; `ask` is accepted only as a legacy alias for `default`
