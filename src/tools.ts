import { PlanEntry, ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import { isObject } from "./utils.js";

export interface CursorToolPayload {
	toolName: string;
	args: Record<string, unknown>;
	result?: Record<string, unknown>;
	rawKey: string;
}

export interface ToolInfo {
	title: string;
	kind: ToolKind;
	content: ToolCallContent[];
	locations?: ToolCallLocation[];
}

export function markdownEscape(text: string): string {
	let fence = "```";
	for (const [m] of text.matchAll(/^```+/gm)) {
		while (m.length >= fence.length) {
			fence += "`";
		}
	}
	return `${fence}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
}

export function extractCursorToolPayload(toolCall: unknown): CursorToolPayload | null {
	if (!isObject(toolCall)) {
		return null;
	}

	const keys = Object.keys(toolCall);
	if (keys.length === 0) {
		return null;
	}

	const rawKey = keys[0];
	const node = toolCall[rawKey];
	if (!isObject(node)) {
		return null;
	}

	const args = isObject(node.args) ? node.args : {};
	const result = isObject(node.result) ? node.result : undefined;

	return {
		toolName: rawKey,
		args,
		result,
		rawKey,
	};
}

function baseToolName(name: string): string {
	return name.endsWith("ToolCall") ? name.slice(0, -"ToolCall".length) : name;
}

function extractText(value: unknown): string | null {
	if (typeof value === "string" && value.length > 0) {
		return value;
	}

	if (Array.isArray(value)) {
		const parts = value
			.map((entry) => {
				if (typeof entry === "string") {
					return entry;
				}
				if (isObject(entry)) {
					if (typeof entry.text === "string") {
						return entry.text;
					}
					if (typeof entry.content === "string") {
						return entry.content;
					}
				}
				return null;
			})
			.filter((entry): entry is string => Boolean(entry));

		if (parts.length > 0) {
			return parts.join("\n");
		}
	}

	if (isObject(value)) {
		if (typeof value.text === "string" && value.text.length > 0) {
			return value.text;
		}
		if (typeof value.content === "string" && value.content.length > 0) {
			return value.content;
		}
		if (typeof value.message === "string" && value.message.length > 0) {
			return value.message;
		}
		if (typeof value.output === "string" && value.output.length > 0) {
			return value.output;
		}
	}

	return null;
}

function extractTextFromRecord(record: Record<string, unknown>): string | null {
	const interleaved = extractText(record.interleavedOutput);
	if (interleaved) {
		return interleaved;
	}

	const stdout = extractText(record.stdout);
	const stderr = extractText(record.stderr);

	if (stdout || stderr) {
		if (stdout && stderr) {
			return `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}`;
		}
		return stdout ?? stderr ?? null;
	}

	const keys = [
		"content",
		"text",
		"output",
		"result",
		"message",
		"lines",
		"fileOutput",
		"fileOutputPath",
	];
	for (const key of keys) {
		const text = extractText(record[key]);
		if (text) {
			return text;
		}
	}

	return null;
}

function textContent(text: string): ToolCallContent[] {
	return [
		{
			type: "content",
			content: {
				type: "text",
				text: markdownEscape(text),
			},
		},
	];
}

export function extractToolResultOutputText(
	result: Record<string, unknown> | undefined,
): string | null {
	if (!result) {
		return null;
	}

	if (isObject(result.success)) {
		const successText = extractTextFromRecord(result.success);
		if (successText) {
			return successText;
		}
	}

	if (isObject(result.error)) {
		const errorText = extractTextFromRecord(result.error);
		if (errorText) {
			return errorText;
		}
	}

	if (isObject(result.rejected)) {
		const rejectedText = extractTextFromRecord(result.rejected);
		if (rejectedText) {
			return rejectedText;
		}
	}

	return extractTextFromRecord(result);
}

// Intentionally no shell-specific formatting here; ACP UI renders the tool output.

function describeShellCommand(args: Record<string, unknown>): {
	title: string;
	content: ToolCallContent[];
} {
	const command = typeof args.command === "string" ? args.command : "";
	const description = typeof args.description === "string" ? args.description : "";

	return {
		title: command ? `\`${command.split("`").join("\\`")}\`` : "Shell",
		content: description
			? [
					{
						type: "content",
						content: { type: "text", text: description },
					},
				]
			: [],
	};
}

export function toolInfoFromCursorToolCall(
	toolNameRaw: string,
	args: Record<string, unknown>,
): ToolInfo {
	const toolName = baseToolName(toolNameRaw);

	switch (toolName) {
		case "shell": {
			const shell = describeShellCommand(args);
			return {
				kind: "execute",
				title: shell.title,
				content: shell.content,
			};
		}

		case "read": {
			const path = typeof args.path === "string" ? args.path : "";
			return {
				kind: "read",
				title: path ? `Read ${path}` : "Read",
				content: [],
				locations: path ? [{ path, line: 0 }] : [],
			};
		}

		case "edit": {
			const path = typeof args.path === "string" ? args.path : "";
			return {
				kind: "edit",
				title: path ? `Edit ${path}` : "Edit",
				content: [],
				locations: path ? [{ path }] : [],
			};
		}

		case "write": {
			const path = typeof args.path === "string" ? args.path : "";
			return {
				kind: "edit",
				title: path ? `Write ${path}` : "Write",
				content: [],
				locations: path ? [{ path }] : [],
			};
		}

		case "updateTodos": {
			return {
				kind: "think",
				title: "Update TODOs",
				content: [],
			};
		}

		default:
			return {
				kind: "other",
				title: toolName || toolNameRaw || "Tool",
				content: [],
			};
	}
}

function maybeDiffContentFromEditResult(
	args: Record<string, unknown>,
	result: Record<string, unknown> | undefined,
): ToolCallContent[] {
	if (!result) {
		return [];
	}

	const success = isObject(result.success) ? result.success : null;
	if (!success) {
		return [];
	}

	const path = typeof args.path === "string" ? args.path : undefined;
	const before =
		typeof success.beforeFullFileContent === "string" ? success.beforeFullFileContent : null;
	const after =
		typeof success.afterFullFileContent === "string" ? success.afterFullFileContent : null;
	const diffString = typeof success.diffString === "string" ? success.diffString : null;

	if (path && before !== null && after !== null) {
		return [
			{
				type: "diff",
				path,
				oldText: before,
				newText: after,
			},
		];
	}

	if (diffString) {
		return [
			{
				type: "content",
				content: {
					type: "text",
					text: markdownEscape(diffString),
				},
			},
		];
	}

	return [];
}

function genericResultContent(result: Record<string, unknown> | undefined): ToolCallContent[] {
	if (!result) {
		return [];
	}

	if (isObject(result.success)) {
		const success = result.success;
		const text = extractTextFromRecord(success);
		if (text) {
			return textContent(text);
		}
	}

	if (isObject(result.error)) {
		const error = result.error;
		const text = extractTextFromRecord(error);
		if (text) {
			return textContent(text);
		}
	}

	if (isObject(result.rejected)) {
		const rejected = result.rejected;
		const command = typeof rejected.command === "string" ? rejected.command : "tool";
		const reason = extractTextFromRecord(rejected);
		return [
			{
				type: "content",
				content: {
					type: "text",
					text: markdownEscape(reason ? `Rejected: ${command}\n${reason}` : `Rejected: ${command}`),
				},
			},
		];
	}

	const topLevelText = extractTextFromRecord(result);
	if (topLevelText) {
		return textContent(topLevelText);
	}

	return [
		{
			type: "content",
			content: {
				type: "text",
				text: markdownEscape(JSON.stringify(result, null, 2)),
			},
		},
	];
}

export function toolUpdateFromCursorToolResult(
	toolNameRaw: string,
	args: Record<string, unknown>,
	result: Record<string, unknown> | undefined,
): { content?: ToolCallContent[]; locations?: ToolCallLocation[] } {
	const toolName = baseToolName(toolNameRaw);

	switch (toolName) {
		case "shell": {
			const outputText = extractToolResultOutputText(result);
			return {
				content: textContent(outputText ?? "Command completed with no output."),
			};
		}

		case "edit": {
			const content = maybeDiffContentFromEditResult(args, result);
			const path = typeof args.path === "string" ? args.path : undefined;
			return {
				content,
				locations: path ? [{ path }] : undefined,
			};
		}

		default:
			return {
				content: genericResultContent(result),
			};
	}
}

export function isRejectedToolResult(result: Record<string, unknown> | undefined): boolean {
	if (!result || !isObject(result)) {
		return false;
	}
	return isObject(result.rejected);
}

export function planEntriesFromCursorTodos(
	result: Record<string, unknown> | undefined,
): PlanEntry[] {
	const success = result && isObject(result.success) ? result.success : null;
	const todos = success && Array.isArray(success.todos) ? success.todos : [];

	return todos
		.filter((todo): todo is Record<string, unknown> => isObject(todo))
		.map((todo) => ({
			content: typeof todo.content === "string" ? todo.content : "Untitled task",
			status: mapTodoStatus(typeof todo.status === "string" ? todo.status : ""),
			priority: "medium",
		}));
}

function mapTodoStatus(status: string): "pending" | "in_progress" | "completed" {
	switch (status) {
		case "TODO_STATUS_COMPLETED":
		case "completed":
			return "completed";
		case "TODO_STATUS_IN_PROGRESS":
		case "in_progress":
			return "in_progress";
		case "TODO_STATUS_PENDING":
		case "pending":
		default:
			return "pending";
	}
}
