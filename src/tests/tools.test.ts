import { describe, expect, it } from "vitest";
import {
	maybeDiffContentFromMutationResult,
	shellToolPresentation,
	toolUpdateFromCursorToolResult,
} from "../tools.js";

describe("tool presentation for ACP", () => {
	it("builds terminal content for shell tools", () => {
		const shell = shellToolPresentation(
			{
				command: "pnpm lint",
				description: "Lint the workspace",
				cd: "/repo",
			},
			"terminal-1",
		);

		expect(shell).toMatchObject({
			title: "pnpm lint",
			cwd: "/repo",
			content: [{ type: "terminal", terminalId: "terminal-1" }],
		});
	});

	it("builds diff content for file mutation tools", () => {
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
