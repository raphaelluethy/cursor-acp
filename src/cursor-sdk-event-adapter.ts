import type { SDKMessage } from "@cursor/sdk";
import type { CursorStreamEvent } from "./cursor-runner.js";
import { isObject } from "./utils.js";

export function sdkToolNameToStreamEventKey(name: string): string {
	const trimmed = name.trim();
	if (trimmed.length === 0) {
		return "toolToolCall";
	}
	return trimmed.endsWith("ToolCall") ? trimmed : `${trimmed}ToolCall`;
}

function normalizeToolArgs(args: unknown): Record<string, unknown> {
	if (!isObject(args)) {
		return {};
	}
	return args;
}

function normalizeToolResult(result: unknown): Record<string, unknown> | undefined {
	if (result === undefined || result === null) {
		return undefined;
	}
	if (!isObject(result)) {
		return { success: { message: String(result) } };
	}
	if (isObject(result.success) || isObject(result.error) || isObject(result.rejected)) {
		return result;
	}
	return { success: result };
}

function buildToolCallPayload(
	name: string,
	args: unknown,
	result?: unknown,
): Record<string, unknown> {
	const key = sdkToolNameToStreamEventKey(name);
	const node: Record<string, unknown> = {
		args: normalizeToolArgs(args),
	};
	const normalizedResult = normalizeToolResult(result);
	if (normalizedResult) {
		node.result = normalizedResult;
	}
	return { [key]: node };
}

export function sdkMessageToCursorStreamEvent(message: SDKMessage): CursorStreamEvent[] {
	switch (message.type) {
		case "system": {
			if (message.subtype !== "init") {
				return [];
			}
			return [
				{
					type: "system",
					subtype: "init",
					session_id: message.agent_id,
					...(message.model ? { model: message.model.id } : {}),
				},
			];
		}

		case "thinking": {
			const text = message.text;
			if (typeof text !== "string" || text.length === 0) {
				return [];
			}
			return [{ type: "thinking", subtype: "delta", text }];
		}

		case "assistant": {
			return [
				{
					type: "assistant",
					message: message.message,
				},
			];
		}

		case "tool_call": {
			const subtype = message.status === "running" ? "started" : "completed";
			return [
				{
					type: "tool_call",
					subtype,
					call_id: message.call_id,
					tool_call: buildToolCallPayload(
						message.name,
						message.args,
						message.status === "running" ? undefined : message.result,
					),
				},
			];
		}

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
		return {
			type: "result",
			subtype: "cancelled",
			is_error: false,
		};
	}

	return {
		type: "result",
		subtype: "error",
		is_error: true,
		result: args.errorText ?? "Cursor SDK run failed",
	};
}
