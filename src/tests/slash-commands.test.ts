import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	availableSlashCommands,
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
		const result = await handleSlashCommand("mode", "yolo", {
			session,
			auth: mockAuth,
			listModels: async () => [],
		});

		expect(result.handled).toBe(true);
		expect(result.responseText).toContain("Mode set to Yolo");
		expect(session.modeId).toBe("yolo");
	});

	it("rejects legacy yolo alias names for /mode", async () => {
		const session = { modelId: "auto", modeId: "default" as const };
		const result = await handleSlashCommand("mode", "bypassPermissions", {
			session,
			auth: mockAuth,
			listModels: async () => [],
		});

		expect(result.handled).toBe(true);
		expect(result.responseText).toContain("Unknown mode");
		expect(session.modeId).toBe("default");
	});

	it("prefers native command metadata over built-in command metadata", () => {
		const commands = availableSlashCommands([
			{
				name: "model",
				description: "Native model command",
				input: { hint: "<native-model>" },
			},
		]);

		expect(commands.find((command) => command.name === "model")).toEqual({
			name: "model",
			description: "Native model command",
			input: { hint: "<native-model>" },
		});
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

	it("keeps wrapper built-ins only when native commands do not collide", () => {
		const commands = availableSlashCommands([
			{ name: "mode", description: "native mode", input: null },
			{ name: "commit", description: "commit helper", input: null },
		]);

		expect(commands.find((command) => command.name === "mode")?.description).toBe(
			"native mode",
		);
		expect(commands.some((command) => command.name === "commit")).toBe(true);
		expect(commands.some((command) => command.name === "help")).toBe(true);
	});

	it("lists merged command metadata in /help output", async () => {
		const result = await handleSlashCommand("help", "", {
			session: { modelId: "auto", modeId: "default" },
			auth: mockAuth,
			listModels: async () => [],
			availableCommands: availableSlashCommands([
				{
					name: "model",
					description: "Native model command",
					input: { hint: "<native-model>" },
				},
				{ name: "commit", description: "commit helper", input: null },
			]),
		});

		expect(result.handled).toBe(true);
		expect(result.responseText).toContain("/model <native-model>");
		expect(result.responseText).toContain("/commit");
		expect(result.responseText).toContain("/help");
	});
});
