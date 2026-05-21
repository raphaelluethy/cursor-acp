import { describe, expect, it } from "vitest";
import {
	sdkMessageToCursorStreamEvent,
	sdkRunResultToCursorResultEvent,
	sdkToolNameToStreamEventKey,
} from "../cursor-sdk-event-adapter.js";
import { type CachedToolUse, mapCursorEventToAcp } from "../cursor-event-mapper.js";

describe("cursor sdk event adapter", () => {
	it("maps sdk tool names to stream event keys", () => {
		expect(sdkToolNameToStreamEventKey("shell")).toBe("shellToolCall");
		expect(sdkToolNameToStreamEventKey("shellToolCall")).toBe("shellToolCall");
	});

	it("maps shell tool lifecycle to ACP notifications", () => {
		const cache: Record<string, CachedToolUse> = {};
		const started = sdkMessageToCursorStreamEvent({
			type: "tool_call",
			agent_id: "agent-1",
			run_id: "run-1",
			call_id: "call_1",
			name: "shell",
			status: "running",
			args: { command: "pwd" },
		});
		expect(started).toHaveLength(1);
		const startedMapped = mapCursorEventToAcp(started[0], {
			sessionId: "s1",
			toolUseCache: cache,
		});
		expect(startedMapped.notifications[0].update).toMatchObject({
			sessionUpdate: "tool_call",
			title: "pwd",
		});

		const completed = sdkMessageToCursorStreamEvent({
			type: "tool_call",
			agent_id: "agent-1",
			run_id: "run-1",
			call_id: "call_1",
			name: "shell",
			status: "completed",
			args: { command: "pwd" },
			result: { stdout: "/tmp\n", exitCode: 0 },
		});
		const completedMapped = mapCursorEventToAcp(completed[0], {
			sessionId: "s1",
			toolUseCache: cache,
		});
		expect(completedMapped.notifications[0].update.sessionUpdate).toBe("tool_call_update");
	});

	it("maps system init to backend session id", () => {
		const events = sdkMessageToCursorStreamEvent({
			type: "system",
			subtype: "init",
			agent_id: "agent-abc",
			run_id: "run-1",
		});
		const mapped = mapCursorEventToAcp(events[0], {
			sessionId: "s1",
			toolUseCache: {},
		});
		expect(mapped.backendSessionId).toBe("agent-abc");
	});

	it("maps run results", () => {
		expect(
			sdkRunResultToCursorResultEvent({ status: "finished", resultText: "done" }),
		).toMatchObject({
			type: "result",
			subtype: "success",
			is_error: false,
			result: "done",
		});
		expect(
			sdkRunResultToCursorResultEvent({ status: "error", errorText: "boom" }),
		).toMatchObject({
			type: "result",
			is_error: true,
		});
	});
});
