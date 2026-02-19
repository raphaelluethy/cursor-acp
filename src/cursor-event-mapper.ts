import { SessionNotification } from "@agentclientprotocol/sdk";
import { CursorStreamEvent } from "./cursor-cli-runner.js";
import { Logger, isObject, sanitizeToolCallId } from "./utils.js";
import {
	CursorToolPayload,
	extractCursorToolPayload,
	extractToolResultOutputText,
	isRejectedToolResult,
	planEntriesFromCursorTodos,
	toolInfoFromCursorToolCall,
	toolUpdateFromCursorToolResult,
} from "./tools.js";

export interface CachedToolUse {
	toolCallId: string;
	payload: CursorToolPayload;
}

export interface RejectedToolCall {
	toolCallId: string;
	title: string;
	rawInput: Record<string, unknown>;
}

export interface MappingContext {
	sessionId: string;
	toolUseCache: Record<string, CachedToolUse>;
	logger?: Logger;
}

export interface MappingResult {
	notifications: SessionNotification[];
	backendSessionId?: string;
	currentModeId?: string;
	rejectedToolCall?: RejectedToolCall;
}

function formatShellToolResponse(
	result: Record<string, unknown> | undefined,
	outputText: string | null,
): string {
	const text = outputText ?? "Command completed with no output.";
	const success = result && isObject(result.success) ? result.success : null;
	const exitCode = success && typeof success.exitCode === "number" ? success.exitCode : undefined;
	const signal =
		success && typeof success.signal === "string" && success.signal.length > 0
			? success.signal
			: undefined;

	let prefix = "";
	if (typeof exitCode === "number") {
		prefix += `Exited with code ${exitCode}.`;
	}
	if (signal) {
		prefix += `${prefix ? " " : ""}Signal \`${signal}\`. `;
	}
	if (prefix) {
		prefix += "Final output:\n\n";
	}

	return prefix ? `${prefix}${text}` : text;
}

function assistantTextChunks(event: CursorStreamEvent): string[] {
	const message = event.message;
	if (!isObject(message)) {
		return [];
	}
	const content = message.content;
	if (!Array.isArray(content)) {
		return [];
	}

	const chunks: string[] = [];
	for (const item of content) {
		if (item && typeof item === "object" && item.type === "text" && typeof item.text === "string") {
			chunks.push(item.text);
		}
	}
	return chunks;
}

export function mapCursorEventToAcp(
	event: CursorStreamEvent,
	context: MappingContext,
): MappingResult {
	const notifications: SessionNotification[] = [];
	const logger = context.logger ?? console;

	if (event.type === "system" && event.subtype === "init") {
		const backendSessionId =
			typeof event.session_id === "string" && event.session_id.length > 0
				? event.session_id
				: undefined;
		const permissionMode =
			typeof event.permissionMode === "string" && event.permissionMode.length > 0
				? event.permissionMode
				: undefined;

		return {
			notifications,
			backendSessionId,
			currentModeId: permissionMode,
		};
	}

	if (event.type === "thinking" && event.subtype === "delta") {
		const text = typeof event.text === "string" ? event.text : "";
		if (text.length > 0) {
			notifications.push({
				sessionId: context.sessionId,
				update: {
					sessionUpdate: "agent_thought_chunk",
					content: {
						type: "text",
						text,
					},
				},
			});
		}

		return { notifications };
	}

	if (event.type === "assistant") {
		for (const text of assistantTextChunks(event)) {
			notifications.push({
				sessionId: context.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text,
					},
				},
			});
		}
		return { notifications };
	}

	if (event.type === "tool_call") {
		const rawCallId = typeof event.call_id === "string" ? event.call_id : "";
		const toolCallId = sanitizeToolCallId(rawCallId || "tool-call");
		const payload = extractCursorToolPayload(event.tool_call);

		if (!payload) {
			logger.error("[cursor-acp] Failed to parse tool_call payload", event);
			return { notifications };
		}

		if (event.subtype === "started") {
			context.toolUseCache[toolCallId] = {
				toolCallId,
				payload,
			};

			const info = toolInfoFromCursorToolCall(payload.toolName, payload.args);
			notifications.push({
				sessionId: context.sessionId,
				update: {
					sessionUpdate: "tool_call",
					toolCallId,
					status: "pending",
					rawInput: payload.args,
					_meta: {
						cursorCli: {
							toolName: payload.toolName,
						},
					},
					...info,
				},
			});
			return { notifications };
		}

		if (event.subtype === "completed") {
			const cached = context.toolUseCache[toolCallId] ?? {
				toolCallId,
				payload,
			};

			const result = payload.result;
			const infoUpdate = toolUpdateFromCursorToolResult(
				cached.payload.toolName,
				cached.payload.args,
				result,
			);
			const status = isRejectedToolResult(result) ? "failed" : "completed";

			const isShellTool = cached.payload.toolName === "shellToolCall";
			const shellOutputText = isShellTool ? extractToolResultOutputText(result) : null;
			const shellToolResponseText = isShellTool
				? formatShellToolResponse(result, shellOutputText)
				: null;

			const isTodoUpdate = cached.payload.toolName === "updateTodosToolCall";
			notifications.push({
				sessionId: context.sessionId,
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId,
					status,
					rawOutput: isShellTool
						? (shellOutputText ?? "Command completed with no output.")
						: result,
					_meta: {
						cursorCli: {
							toolName: cached.payload.toolName,
							rawResult: isShellTool ? result : undefined,
						},
						...(shellToolResponseText
							? {
									claudeCode: {
										toolName: cached.payload.toolName,
										toolResponse: [
											{
												type: "text",
												text: shellToolResponseText,
											},
										],
									},
								}
							: {}),
					},
					...infoUpdate,
				},
			});

			if (isTodoUpdate) {
				const entries = planEntriesFromCursorTodos(result);
				notifications.push({
					sessionId: context.sessionId,
					update: {
						sessionUpdate: "plan",
						entries,
					},
				});
			}

			delete context.toolUseCache[toolCallId];

			if (isRejectedToolResult(result)) {
				const info = toolInfoFromCursorToolCall(cached.payload.toolName, cached.payload.args);
				return {
					notifications,
					rejectedToolCall: {
						toolCallId,
						title: info.title,
						rawInput: cached.payload.args,
					},
				};
			}

			return { notifications };
		}
	}

	return { notifications };
}
