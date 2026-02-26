import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	handleSlashCommand,
	loadCustomSlashCommands,
	parseModelListOutput,
	resolveCustomSlashCommandPrompt,
} from "../slash-commands.js";

const mockAuth = {
	async status() {
		return { loggedIn: true as const, account: "user@example.com", raw: "" };
	},
	async login() {
		return { code: 0, stdout: "", stderr: "" };
	},
	async logout() {
		return { code: 0, stdout: "", stderr: "" };
	},
	async ensureLoggedIn() {
		return { loggedIn: true as const, account: "user@example.com", raw: "" };
	},
};

describe("slash commands", () => {
	it("parses model output", () => {
		const parsed = parseModelListOutput(
			`Available models\nauto - Auto\ngpt-5.2 - GPT-5.2 (current)`,
		);
		expect(parsed).toEqual([
			{ modelId: "auto", name: "Auto", current: false },
			{ modelId: "gpt-5.2", name: "GPT-5.2", current: true },
		]);
	});

	it("handles /model set", async () => {
		const session = { modelId: "auto", modeId: "default" as const };
		const result = await handleSlashCommand("model", "gpt-5.2", {
			session,
			auth: mockAuth,
			listModels: async () => [
				{ modelId: "auto", name: "Auto" },
				{ modelId: "gpt-5.2", name: "GPT-5.2" },
			],
		});

		expect(result.handled).toBe(true);
		expect(result.responseText).toContain("Model set to gpt-5.2");
		expect(session.modelId).toBe("gpt-5.2");
	});

	it("handles /mode set", async () => {
		const session = { modelId: "auto", modeId: "default" as const };
		const result = await handleSlashCommand("mode", "plan", {
			session,
			auth: mockAuth,
			listModels: async () => [],
		});

		expect(result.handled).toBe(true);
		expect(result.responseText).toContain("Mode set to plan");
		expect(session.modeId).toBe("plan");
	});

	it("loads custom slash commands from workspace and home", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-test-"));
		const workspace = path.join(tempRoot, "workspace");
		const home = path.join(tempRoot, "home");

		await mkdir(path.join(workspace, ".cursor", "commands"), {
			recursive: true,
		});
		await mkdir(path.join(home, ".cursor", "commands"), { recursive: true });

		await writeFile(
			path.join(workspace, ".cursor", "commands", "commit.md"),
			[
				"---",
				"description: Create a git commit message",
				"argument-hint: <scope>",
				"---",
				"Write a conventional commit message.",
				"Scope: $ARGUMENTS",
			].join("\n"),
			"utf8",
		);

		await writeFile(
			path.join(home, ".cursor", "commands", "review.md"),
			"Review the recent changes carefully.",
			"utf8",
		);

		await writeFile(
			path.join(home, ".cursor", "commands", "commit.md"),
			"This should be ignored because workspace takes precedence.",
			"utf8",
		);

		try {
			const commands = await loadCustomSlashCommands(workspace, home);
			expect(commands.map((c) => c.name)).toEqual(["commit", "review"]);
			expect(commands[0]?.description).toContain("commit message");
			expect(commands[0]?.argumentHint).toBe("<scope>");
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	it("expands custom slash command template placeholders", () => {
		const prompt = resolveCustomSlashCommandPrompt(
			"commit",
			'feat(parser) "improve tokenizer"',
			[
				{
					name: "commit",
					description: "Generate commit message",
					argumentHint: "<scope> <subject>",
					template:
						"Write a commit.\nScope: $1\nSubject: $2\nRaw: $ARGUMENTS\nPrice: $$20",
					sourcePath: "/tmp/commit.md",
				},
			],
		);

		expect(prompt).toContain("Scope: feat(parser)");
		expect(prompt).toContain("Subject: improve tokenizer");
		expect(prompt).toContain('Raw: feat(parser) "improve tokenizer"');
		expect(prompt).toContain("Price: $20");
	});
});
