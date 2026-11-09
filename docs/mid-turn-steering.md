# Mid-turn steering for ACP clients

This page describes **cursor-acp agent behavior** for clients that send overlapping ACP `session/prompt` requests. It does not define a new ACP protocol extension or require Cursor-specific client logic. The adapter uses ACP request, response, notification, and error behavior plus the existing top-level `initialize` declaration `_meta.midTurnSteering: true`.

## Capability and prompt lifecycle

The adapter declares `_meta.midTurnSteering: true` only when its selected runner supports the Cursor SDK's `run.steer(text)`. Without that capability, it omits the declaration and retains the ordinary single-prompt behavior. An idle session handles a prompt as a normal primary run.

During a run, the adapter serializes arriving prompts in arrival order. If no earlier input is queued, it converts the prompt to steer text and calls `run.steer(text)`. A `complete_delivered` result keeps that ACP prompt open until the shared turn finishes; its response uses the primary prompt's stop reason. The run is not restarted for this delivery. Prompts arriving before the SDK run exists, or during a gap between runs such as an approval retry, wait for a later run.

If the SDK returns `revert_to_followup`, the adapter does not retry steering. It queues that input as a new run on the same session after the current SDK run ends. That ACP prompt responds when its own run finishes. While any deferred input is queued, later prompts join the queue in arrival order instead of overtaking it with `run.steer`. Prompts queued during an approval retry gap also run after the retry. A client can therefore keep the connection in steering mode across a deferred input.

The adapter writes both delivered and deferred inputs as user messages in its visible session history. After session resume, their user messages appear in the history replay.

## Attachment conversion

`run.steer` accepts text. For a steer, the adapter preserves the order of ACP content blocks: text stays text; an image with data or embedded resource is saved to a file; a resource link is represented by its URI. Every saved attachment is replaced by this fixed reference line:

```text
[attachment: <absolute path> (MIME: <mime type>) — use the read-file tool to view it if needed]
```

The files live under the system temporary directory at `cursor-acp-attachments/<sessionId>/`. The session directory has mode `0700`, files have mode `0600`, and file extensions follow their MIME types. A deferred steer runs with the same converted text and file paths it would have used for injection. The adapter removes a session's files when the session closes or cancellation leaves no pending references. On adapter startup, it removes session attachment directories older than 24 hours according to each directory's modification time.

An idle primary prompt keeps the adapter's normal image handling. In a steer, the agent sees attachment **paths**, not inline images; it decides whether to use its read-file tool to inspect them.

## Errors, cancellation, and approval

Normal injection and deferral paths do not return a busy error. `INVALID_PARAMS` with a message containing `already in flight` is an internal fallback for a prompt the adapter cannot safely accept. A client that uses this error as a fallback signal should only act on that exact combination; ordinary errors indicate failure.

`session/cancel` cancels the current SDK run, discards the deferred queue, and settles the primary prompt and every pending steer or deferred prompt with `stopReason: "cancelled"`. This includes a steer still waiting for the SDK's delivery result. Attachment files are removed after cancellation when no pending prompt needs them. A new prompt submitted after cancellation waits until the old SDK run has finished and its attachment cleanup has completed, then starts the next turn. A configuration change submitted after cancellation waits the same way when it would actually change the next turn's model, thinking level, or fast value; reapplying the current fast value changes nothing and returns immediately. A configuration change during a run that was not cancelled is still rejected, and a new turn does not start while an accepted configuration change is still in flight.

A steer neither cancels nor answers a pending ACP permission request. In auto-review mode, a rejected tool call is surfaced as an ACP permission request. If approved, the adapter retries the whole turn with auto-review disabled. The retry prompt contains the original prompt followed by **all** `complete_delivered` steer texts in delivery order, separated by blank lines. Inputs received while that approval is pending wait for a later run.

## Known limits

- A steer rejected by Cursor at the end of a turn actually runs **after** that SDK run. A client that marks every overlapping prompt as injected may show a more optimistic label than the execution timing.
- The agent receives file paths and MIME hints for steer attachments. It does not receive those images inline.
- Approval fallback retries the whole turn. Work completed before the rejected tool call may run again.

## Behavior and API regression tests

The named tests below exercise the ACP agent boundary with an injected runner. They are in `src/tests/cursor-acp-agent.test.ts`, except the startup test in `src/tests/steer-startup-api.test.ts`.

| Documented behavior | Named test |
| --- | --- |
| Conditional top-level capability declaration; ordinary single-prompt fallback | `initialize advertises only the top-level midTurnSteering declaration`; `rejects a second prompt while one is in progress` |
| Idle prompt starts a primary run with ordinary image input; prompt before run creation waits | `idle primary prompt preserves SDK image input`; `prompt arriving before the SDK run queues behind it` |
| Delivered steer shares the run, stop reason, and history; overlapping steers stay ordered | `delivered steer settles with the shared run`; `stacked steers are delivered in arrival order`; `delivered steer is visible when the session resumes` |
| Reverted steer becomes a later run; later inputs queue; retry gaps queue | `reverted steer runs as a new run after the current one`; `prompts after a deferred input queue behind it`; `prompt during permission retry gap queues for a later run` |
| Deferred steer appears in resumed history | `delivered steer is visible when the session resumes` |
| Configuration change after cancel waits for the old run, repeated fast value is a no-op, live-run changes still reject | `reapplies the current fast value after cancel while the old run still exits`; `applies a changed fast value after cancel once the old run exits`; `applies a model change after cancel and still rejects one during a live run`; `applies a thinking change after cancel once the old run exits`; `applies a legacy set_model request after cancel once the old run exits`; `applies an in-flight config change before the next turn starts`; `queues a second prompt that waited on the same config change` |
| Text, image, embedded resource, resource link, fixed reference line, MIME extension, file and directory modes | `non-text blocks in a steer become temp-file references in order` |
| Deferred attachment keeps its converted path; paths remain readable during its run | `deferred steer with attachments runs with the temp-file reference text` |
| Session close, cancel, and racing writes clean attachment files | `attachment files are cleaned up on session close`; `cancel settles pending and deferred prompts as cancelled`; `cancel during attachment writes still removes the files` |
| Startup cleanup after 24 hours by directory mtime | `adapter startup removes attachment directories older than 24 hours` |
| Busy error only as fallback; normal steer and deferral do not emit it | `steer paths never return the busy error`; `rejects a second prompt while one is in progress` |
| Cancel settles pending delivery and deferred queue; a subsequent prompt waits for safe reuse | `cancel settles an unresolved steer delivery as cancelled`; `cancel settles pending and deferred prompts as cancelled`; `cancel during attachment writes still removes the files` |
| Steer leaves permission request pending; approved retry includes delivered texts in order | `steer does not cancel a pending permission request`; `permission retry replays delivered steers` |
| End-of-turn deferral may be displayed as injection by a client; attachment is a path rather than inline image | `reverted steer runs as a new run after the current one`; `non-text blocks in a steer become temp-file references in order` |
| Whole-turn approval retry may repeat earlier work | `permission retry replays delivered steers` |
