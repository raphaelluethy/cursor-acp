import { describe, expect, it } from "vitest";
import { sdkMessageToCursorStreamEvent } from "../cursor-sdk-event-adapter.js";

describe("Cursor SDK event adapter", () => {
	it("maps an Auto Review denial to a rejected legacy tool result", () => {
		const events = sdkMessageToCursorStreamEvent({
			type: "tool_call",
			agent_id: "agent-1",
			run_id: "run-1",
			call_id: "call-1",
			name: "shell",
			args: { command: "example" },
			status: "error",
			result: { message: "Stopped at the auto-approval boundary" },
		});

		expect(events[0]).toMatchObject({
			type: "tool_call",
			subtype: "completed",
			call_id: "call-1",
			tool_call: {
				shellToolCall: {
					result: { rejected: { message: expect.stringContaining("auto-approval") } },
				},
			},
		});
	});

	it("preserves successful tool results", () => {
		const events = sdkMessageToCursorStreamEvent({
			type: "tool_call",
			agent_id: "agent-1",
			run_id: "run-1",
			call_id: "call-2",
			name: "read",
			args: { path: "README.md" },
			status: "completed",
			result: { content: "ok" },
		});

		expect(events[0]).toMatchObject({
			tool_call: { readToolCall: { result: { success: { content: "ok" } } } },
		});
	});
});
