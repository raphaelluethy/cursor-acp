import { describe, expect, it } from "vitest";
import { ToolCallContent } from "@agentclientprotocol/sdk";
import {
	maybeDiffContentFromMutationResult,
	shellToolPresentation,
	toolUpdateFromCursorToolResult,
} from "../tools.js";

function textFromContent(content: ToolCallContent[] | undefined): string {
	const first = content?.[0];
	if (
		first &&
		first.type === "content" &&
		first.content?.type === "text" &&
		typeof first.content.text === "string"
	) {
		return first.content.text;
	}
	return "";
}

describe("toolUpdateFromCursorToolResult", () => {
	it("builds terminal content for shell tool presentation", () => {
		const shell = shellToolPresentation(
			{
				command: "pnpm lint",
				description: "Lint the workspace",
				cd: "/repo",
			},
			"terminal-1",
		);

		expect(shell.title).toBe("`pnpm lint`");
		expect(shell.cwd).toBe("/repo");
		expect(shell.content).toEqual([{ type: "terminal", terminalId: "terminal-1" }]);
	});

	it("includes stdout and stderr output", () => {
		const update = toolUpdateFromCursorToolResult(
			"shellToolCall",
			{ command: "ls" },
			{
				success: {
					stdout: "line1\n",
					stderr: "warn\n",
				},
			},
			"terminal-1",
		);

		expect(update.content).toEqual([{ type: "terminal", terminalId: "terminal-1" }]);
	});

	it("falls back to content/text fields", () => {
		const update = toolUpdateFromCursorToolResult(
			"readToolCall",
			{ path: "/tmp/file" },
			{
				success: {
					content: "hello world",
				},
			},
		);

		const text = textFromContent(update.content);
		expect(text).toContain("hello world");
	});

	it("uses interleaved output when present", () => {
		const update = toolUpdateFromCursorToolResult(
			"shellToolCall",
			{ command: "echo hi" },
			{
				success: {
					interleavedOutput: "hi\n",
					stdout: "",
					stderr: "",
				},
			},
		);

		const text = textFromContent(update.content);
		expect(text).toContain("hi");
	});

	it("builds diff content for write tool results like edit", () => {
		const diff = maybeDiffContentFromMutationResult(
			{ path: "/p/x.txt" },
			{
				success: {
					beforeFullFileContent: "a\n",
					afterFullFileContent: "b\n",
				},
			},
		);
		expect(diff).toEqual([{ type: "diff", path: "/p/x.txt", oldText: "a\n", newText: "b\n" }]);

		const update = toolUpdateFromCursorToolResult(
			"writeToolCall",
			{ path: "/p/x.txt" },
			{
				success: {
					beforeFullFileContent: "old",
					afterFullFileContent: "new",
				},
			},
		);
		expect(update.content).toEqual([
			{ type: "diff", path: "/p/x.txt", oldText: "old", newText: "new" },
		]);
		expect(update.locations).toEqual([{ path: "/p/x.txt" }]);
	});
});
