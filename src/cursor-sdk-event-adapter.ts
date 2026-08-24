import type { SDKMessage } from "@cursor/sdk";
import type { CursorStreamEvent } from "./cursor-runner.js";
import { isObject } from "./utils.js";

const INTERACTIVE_APPROVAL_MARKERS = [
	"cannot request interactive approval",
	"auto-approval boundary",
	"approval required",
];

export function sdkToolNameToStreamEventKey(name: string): string {
	const trimmed = name.trim();
	if (trimmed.length === 0) {
		return "toolToolCall";
	}
	return trimmed.endsWith("ToolCall") ? trimmed : `${trimmed}ToolCall`;
}

function normalizeToolArgs(args: unknown): Record<string, unknown> {
	return isObject(args) ? args : {};
}

function containsApprovalDenial(value: unknown): boolean {
	if (typeof value === "string") {
		const normalized = value.toLowerCase();
		return INTERACTIVE_APPROVAL_MARKERS.some((marker) => normalized.includes(marker));
	}
	if (Array.isArray(value)) {
		return value.some(containsApprovalDenial);
	}
	if (isObject(value)) {
		return Object.values(value).some(containsApprovalDenial);
	}
	return false;
}

function normalizeToolResult(
	result: unknown,
	status: "running" | "completed" | "error",
): Record<string, unknown> | undefined {
	if (result === undefined || result === null) {
		return status === "error" ? { error: { message: "Tool call failed" } } : undefined;
	}
	if (status === "error" && containsApprovalDenial(result)) {
		return { rejected: isObject(result) ? result : { message: String(result) } };
	}
	if (!isObject(result)) {
		const branch = status === "error" ? "error" : "success";
		return { [branch]: { message: String(result) } };
	}
	if (isObject(result.success) || isObject(result.error) || isObject(result.rejected)) {
		return result;
	}
	return { [status === "error" ? "error" : "success"]: result };
}

function buildToolCallPayload(message: Extract<SDKMessage, { type: "tool_call" }>) {
	const node: Record<string, unknown> = {
		args: normalizeToolArgs(message.args),
	};
	const result = normalizeToolResult(message.result, message.status);
	if (result) {
		node.result = result;
	}
	return { [sdkToolNameToStreamEventKey(message.name)]: node };
}

export function sdkMessageToCursorStreamEvent(message: SDKMessage): CursorStreamEvent[] {
	switch (message.type) {
		case "system":
			return message.subtype === "init"
				? [
						{
							type: "system",
							subtype: "init",
							session_id: message.agent_id,
							...(message.model ? { model: message.model.id } : {}),
						},
					]
				: [];
		case "thinking":
			return message.text.length > 0
				? [{ type: "thinking", subtype: "delta", text: message.text }]
				: [];
		case "assistant":
			return [{ type: "assistant", message: message.message }];
		case "tool_call":
			return [
				{
					type: "tool_call",
					subtype: message.status === "running" ? "started" : "completed",
					call_id: message.call_id,
					tool_call: buildToolCallPayload(message),
				},
			];
		default:
			return [];
	}
}

export function sdkRunResultToCursorResultEvent(args: {
	status: "finished" | "error" | "cancelled";
	resultText?: string;
	errorText?: string;
}): CursorStreamEvent {
	if (args.status === "finished") {
		return {
			type: "result",
			subtype: "success",
			is_error: false,
			...(args.resultText ? { result: args.resultText } : {}),
		};
	}
	if (args.status === "cancelled") {
		return { type: "result", subtype: "cancelled", is_error: false };
	}
	return {
		type: "result",
		subtype: "error",
		is_error: true,
		result: args.errorText ?? "Cursor SDK run failed",
	};
}
