import { describe, expect, it } from "vitest";
import { mapCursorEventToAcp } from "../cursor-event-mapper.js";

describe("cursor event mapper", () => {
  it("maps thinking delta", () => {
    const result = mapCursorEventToAcp(
      { type: "thinking", subtype: "delta", text: "hello" },
      { sessionId: "s1", toolUseCache: {} },
    );

    expect(result.notifications).toEqual([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "hello" },
        },
      },
    ]);
  });

  it("maps tool start and completion", () => {
    const cache = {} as any;

    const started = mapCursorEventToAcp(
      {
        type: "tool_call",
        subtype: "started",
        call_id: "call_1",
        tool_call: {
          shellToolCall: {
            args: { command: "pwd" },
          },
        },
      },
      { sessionId: "s1", toolUseCache: cache },
    );

    expect(started.notifications[0].update.sessionUpdate).toBe("tool_call");

    const completed = mapCursorEventToAcp(
      {
        type: "tool_call",
        subtype: "completed",
        call_id: "call_1",
        tool_call: {
          shellToolCall: {
            args: { command: "pwd" },
            result: {
              success: { stdout: "/tmp\n" },
            },
          },
        },
      },
      { sessionId: "s1", toolUseCache: cache },
    );

    expect(completed.notifications[0].update.sessionUpdate).toBe(
      "tool_call_update",
    );
    expect((completed.notifications[0].update as any).status).toBe("completed");
  });

  it("maps todo completion to plan", () => {
    const cache = {} as any;

    mapCursorEventToAcp(
      {
        type: "tool_call",
        subtype: "started",
        call_id: "todo_1",
        tool_call: {
          updateTodosToolCall: {
            args: {},
          },
        },
      },
      { sessionId: "s1", toolUseCache: cache },
    );

    const done = mapCursorEventToAcp(
      {
        type: "tool_call",
        subtype: "completed",
        call_id: "todo_1",
        tool_call: {
          updateTodosToolCall: {
            args: {},
            result: {
              success: {
                todos: [
                  { content: "Inspect repo", status: "TODO_STATUS_PENDING" },
                ],
              },
            },
          },
        },
      },
      { sessionId: "s1", toolUseCache: cache },
    );

    expect(done.notifications[0]).toEqual({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "todo_1",
        status: "completed",
        rawOutput: {
          success: {
            todos: [{ content: "Inspect repo", status: "TODO_STATUS_PENDING" }],
          },
        },
        _meta: {
          cursorCli: {
            toolName: "updateTodosToolCall",
          },
        },
      },
    });

    expect(done.notifications[1]).toEqual({
      sessionId: "s1",
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: "Inspect repo", priority: "medium", status: "pending" },
        ],
      },
    });
  });
});
