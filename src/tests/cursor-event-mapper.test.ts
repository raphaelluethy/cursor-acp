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
		const cache: Record<string, CachedToolUse> = {};

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
		const startedUpdate = started.notifications[0].update as ToolCallNotificationUpdate;
		expect(startedUpdate.status).toBe("in_progress");
		expect(startedUpdate.kind).toBe("execute");
		expect(startedUpdate.title).toBe("pwd");
		expect(startedUpdate.content).toEqual([
			{ type: "terminal", terminalId: "cursor-shell-call_1" },
		]);
		expect(startedUpdate._meta?.terminal_info).toEqual({
			terminal_id: "cursor-shell-call_1",
		});

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

		expect(completed.notifications[0].update.sessionUpdate).toBe("tool_call_update");
		expect(
			(completed.notifications[0].update as ToolCallNotificationUpdate)._meta
				?.terminal_output,
		).toEqual({
			terminal_id: "cursor-shell-call_1",
			data: "/tmp\n",
		});
		const update = completed.notifications[1].update as ToolCallNotificationUpdate;
		expect(update.status).toBe("completed");
		expect(update.content).toEqual([{ type: "terminal", terminalId: "cursor-shell-call_1" }]);
		expect(update._meta?.terminal_exit).toEqual({
			terminal_id: "cursor-shell-call_1",
			exit_code: 0,
			signal: null,
		});
	});

	it("includes terminal cwd and description on shell tool start", () => {
		const cache: Record<string, CachedToolUse> = {};

		const started = mapCursorEventToAcp(
			{
				type: "tool_call",
				subtype: "started",
				call_id: "call_2",
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

		const update = started.notifications[0].update as ToolCallNotificationUpdate;
		expect(update.content).toEqual([{ type: "terminal", terminalId: "cursor-shell-call_2" }]);
		expect(update._meta?.terminal_info).toEqual({
			terminal_id: "cursor-shell-call_2",
			cwd: "/workspace/app",
		});
	});

	it("maps edit tool start to in_progress with provisional diff when args allow", () => {
		const cache: Record<string, CachedToolUse> = {};

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
			{ sessionId: "s1", toolUseCache: cache },
		);

		const u = started.notifications[0].update as ToolCallNotificationUpdate;
		expect(u.status).toBe("in_progress");
		expect(u.kind).toBe("edit");
		expect(u.content).toEqual([
			{ type: "diff", path: "/proj/a.ts", oldText: "foo", newText: "bar" },
		]);
	});

	it("maps todo completion to plan", () => {
		const cache: Record<string, CachedToolUse> = {};

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
								todos: [{ content: "Inspect repo", status: "TODO_STATUS_PENDING" }],
							},
						},
					},
				},
			},
			{ sessionId: "s1", toolUseCache: cache },
		);

		expect(done.notifications[0].update.sessionUpdate).toBe("tool_call_update");
		const todoUpdate = done.notifications[0].update;
		if (todoUpdate.sessionUpdate !== "tool_call_update") {
			throw new Error("Expected tool_call_update");
		}
		expect(todoUpdate.status).toBe("completed");
		expect(todoUpdate.rawOutput).toEqual({
			success: {
				todos: [{ content: "Inspect repo", status: "TODO_STATUS_PENDING" }],
			},
		});
		expect(
			todoUpdate.content?.[0] &&
				"content" in todoUpdate.content[0] &&
				todoUpdate.content[0].content.type === "text"
				? todoUpdate.content[0].content.text
				: "",
		).toContain("todos");

		expect(done.notifications[1]).toEqual({
			sessionId: "s1",
			update: {
				sessionUpdate: "plan",
				entries: [{ content: "Inspect repo", priority: "medium", status: "pending" }],
			},
		});
	});
});
