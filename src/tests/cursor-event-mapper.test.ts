import { describe, expect, it } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { type CachedToolUse, mapCursorEventToAcp } from "../cursor-event-mapper.js";

type ToolCallNotificationUpdate = Extract<
	SessionNotification["update"],
	{ sessionUpdate: "tool_call" | "tool_call_update" }
> & {
	_meta?: {
		terminal_info?: Record<string, unknown>;
		terminal_output?: Record<string, unknown>;
	};
};

describe("cursor event mapper", () => {
	it("maps thinking deltas to agent thought chunks", () => {
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

	it("maps shell tool lifecycle to terminal tool calls", () => {
		const cache: Record<string, CachedToolUse> = {};

		const started = mapCursorEventToAcp(
			{
				type: "tool_call",
				subtype: "started",
				call_id: "call_1",
				tool_call: {
					shellToolCall: {
						args: {
							command: "npm test",
							description: "Run the test suite",
							cd: "/workspace/app",
						},
					},
				},
			},
			{ sessionId: "s1", toolUseCache: cache },
		);

		const startedUpdate = started.notifications[0].update as ToolCallNotificationUpdate;
		expect(startedUpdate).toMatchObject({
			sessionUpdate: "tool_call",
			status: "in_progress",
			kind: "execute",
			title: "npm test",
			content: [{ type: "terminal", terminalId: "cursor-shell-call_1" }],
		});
		expect(startedUpdate._meta?.terminal_info).toEqual({
			terminal_id: "cursor-shell-call_1",
			cwd: "/workspace/app",
		});

		const completed = mapCursorEventToAcp(
			{
				type: "tool_call",
				subtype: "completed",
				call_id: "call_1",
				tool_call: {
					shellToolCall: {
						args: { command: "npm test" },
						result: {
							success: { stdout: "/tmp\n" },
						},
					},
				},
			},
			{ sessionId: "s1", toolUseCache: cache },
		);

		const completedUpdate = completed.notifications[0].update as ToolCallNotificationUpdate;
		expect(completedUpdate.sessionUpdate).toBe("tool_call_update");
		expect(completedUpdate._meta?.terminal_output).toEqual({
			terminal_id: "cursor-shell-call_1",
			data: "/tmp\n",
		});
		expect(completed.notifications[1].update).toMatchObject({
			sessionUpdate: "tool_call_update",
			status: "completed",
			content: [{ type: "terminal", terminalId: "cursor-shell-call_1" }],
		});
	});

	it("maps edit tool start to provisional diff content", () => {
		const started = mapCursorEventToAcp(
			{
				type: "tool_call",
				subtype: "started",
				call_id: "edit_1",
				tool_call: {
					editToolCall: {
						args: {
							path: "/proj/a.ts",
							old_string: "foo",
							new_string: "bar",
						},
					},
				},
			},
			{ sessionId: "s1", toolUseCache: {} },
		);

		const update = started.notifications[0].update as ToolCallNotificationUpdate;
		expect(update).toMatchObject({
			status: "in_progress",
			kind: "edit",
			content: [{ type: "diff", path: "/proj/a.ts", oldText: "foo", newText: "bar" }],
		});
	});

	it("maps todo completion to plan updates", () => {
		const cache: Record<string, CachedToolUse> = {};

		mapCursorEventToAcp(
			{
				type: "tool_call",
				subtype: "started",
				call_id: "todo_1",
				tool_call: { updateTodosToolCall: { args: {} } },
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
								todos: [{ content: "Inspect repo", status: "TODO_STATUS_PENDING" }],
							},
						},
					},
				},
			},
			{ sessionId: "s1", toolUseCache: cache },
		);

		expect(done.notifications[1]).toEqual({
			sessionId: "s1",
			update: {
				sessionUpdate: "plan",
				entries: [{ content: "Inspect repo", priority: "medium", status: "pending" }],
			},
		});
	});
});
