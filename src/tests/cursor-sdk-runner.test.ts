import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CURSOR_ACP_ATTRIBUTE_COMMITS_ENV,
	CURSOR_ACP_ATTRIBUTE_PRS_ENV,
} from "../cursor-cli-config.js";
import type { CursorStreamEvent } from "../cursor-runner.js";
import { CursorSdkRunner } from "../cursor-sdk-runner.js";

const sdkMocks = vi.hoisted(() => ({
	agentCreate: vi.fn(),
	agentResume: vi.fn(),
	modelList: vi.fn(),
}));

const logger = { log() {}, error() {} };
const originalConfigDir = process.env.CURSOR_CONFIG_DIR;
const originalCommitAttribution = process.env[CURSOR_ACP_ATTRIBUTE_COMMITS_ENV];
const originalPrAttribution = process.env[CURSOR_ACP_ATTRIBUTE_PRS_ENV];

vi.mock("@cursor/sdk", () => ({
	Agent: { create: sdkMocks.agentCreate, resume: sdkMocks.agentResume },
	Cursor: { models: { list: sdkMocks.modelList } },
}));

function sdkRun(messages: unknown[] = []) {
	return {
		cancel: vi.fn(async () => undefined),
		async *stream() {
			for (const message of messages) yield message;
		},
		wait: vi.fn(async () => ({ status: "finished", result: "done" })),
	};
}

function sdkAgent(agentId: string, messages: unknown[] = []) {
	return {
		agentId,
		close: vi.fn(),
		send: vi.fn(async () => sdkRun(messages)),
	};
}

describe("CursorSdkRunner", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		if (originalConfigDir === undefined) delete process.env.CURSOR_CONFIG_DIR;
		else process.env.CURSOR_CONFIG_DIR = originalConfigDir;
		if (originalCommitAttribution === undefined) {
			delete process.env[CURSOR_ACP_ATTRIBUTE_COMMITS_ENV];
		} else {
			process.env[CURSOR_ACP_ATTRIBUTE_COMMITS_ENV] = originalCommitAttribution;
		}
		if (originalPrAttribution === undefined) {
			delete process.env[CURSOR_ACP_ATTRIBUTE_PRS_ENV];
		} else {
			process.env[CURSOR_ACP_ATTRIBUTE_PRS_ENV] = originalPrAttribution;
		}
	});

	it("applies global attribution settings before creating the SDK agent", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "cursor-sdk-runner-config-"));
		writeFileSync(
			join(configDir, "cli-config.json"),
			JSON.stringify({
				attribution: { attributeCommitsToAgent: false, attributePRsToAgent: false },
			}),
		);
		process.env.CURSOR_CONFIG_DIR = configDir;
		const agent = sdkAgent("agent-attribution");
		sdkMocks.agentCreate.mockImplementation(async () => {
			expect(process.env[CURSOR_ACP_ATTRIBUTE_COMMITS_ENV]).toBe("false");
			expect(process.env[CURSOR_ACP_ATTRIBUTE_PRS_ENV]).toBe("false");
			return agent;
		});

		const runner = new CursorSdkRunner("test-key", logger);
		await runner.startPrompt({ workspace: "/tmp/project", prompt: "hello" }).completed;

		expect(sdkMocks.agentCreate).toHaveBeenCalledOnce();
	});

	it("creates local agents with Auto Review enabled by default", async () => {
		const agent = sdkAgent("agent-real");
		sdkMocks.agentCreate.mockResolvedValue(agent);
		const runner = new CursorSdkRunner("test-key", logger);

		await runner.startPrompt({
			workspace: "/tmp/project",
			backendSessionId: await runner.createChat(),
			prompt: "hello",
		}).completed;

		expect(sdkMocks.agentCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				local: expect.objectContaining({ cwd: "/tmp/project", autoReview: true }),
			}),
		);
	});

	it("resumes with Auto Review disabled for an approved retry without SDK force", async () => {
		const reviewed = sdkAgent("agent-existing");
		const approved = sdkAgent("agent-existing");
		sdkMocks.agentResume.mockResolvedValueOnce(reviewed).mockResolvedValueOnce(approved);
		const runner = new CursorSdkRunner("test-key", logger);

		await runner.startPrompt({
			workspace: "/tmp/project",
			backendSessionId: "agent-existing",
			prompt: "first",
			reviewPolicy: "auto-review",
		}).completed;
		await runner.startPrompt({
			workspace: "/tmp/project",
			backendSessionId: "agent-existing",
			prompt: "retry",
			reviewPolicy: "run-everything",
		}).completed;

		expect(reviewed.close).toHaveBeenCalledOnce();
		expect(sdkMocks.agentResume).toHaveBeenNthCalledWith(
			2,
			"agent-existing",
			expect.objectContaining({ local: expect.objectContaining({ autoReview: false }) }),
		);
		expect(approved.send).toHaveBeenCalledWith(
			"retry",
			expect.not.objectContaining({ local: expect.anything() }),
		);
	});

	it("forwards ACP MCP servers and image chunks to the SDK", async () => {
		const agent = sdkAgent("agent-real");
		sdkMocks.agentCreate.mockResolvedValue(agent);
		const runner = new CursorSdkRunner("test-key", logger);

		await runner.startPrompt({
			workspace: "/tmp/project",
			prompt: "inspect",
			images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
			mcpServers: [{ name: "local", command: "/bin/tool", args: ["serve"], env: [] }],
		}).completed;

		expect(sdkMocks.agentCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				mcpServers: {
					local: { type: "stdio", command: "/bin/tool", args: ["serve"], env: {} },
				},
			}),
		);
		expect(agent.send).toHaveBeenCalledWith(
			{ text: "inspect", images: [{ data: "aW1hZ2U=", mimeType: "image/png" }] },
			expect.objectContaining({ mcpServers: expect.any(Object) }),
		);
	});

	it("turns a tool left running by Auto Review into a rejected tool event", async () => {
		const agent = sdkAgent("agent-real", [
			{
				type: "tool_call",
				call_id: "call-1",
				name: "mcp",
				args: { tool: "dangerous" },
				status: "running",
			},
			{
				type: "tool_call",
				call_id: "call-1",
				name: "mcp",
				args: { tool: "dangerous" },
				status: "running",
			},
		]);
		sdkMocks.agentCreate.mockResolvedValue(agent);
		const runner = new CursorSdkRunner("test-key", logger);
		const events: CursorStreamEvent[] = [];

		await runner.startPrompt({
			workspace: "/tmp/project",
			prompt: "run it",
			onEvent: (event) => {
				events.push(event);
			},
		}).completed;

		expect(events).toContainEqual(
			expect.objectContaining({
				type: "tool_call",
				subtype: "completed",
				tool_call: expect.objectContaining({
					mcpToolCall: expect.objectContaining({ result: expect.any(Object) }),
				}),
			}),
		);
		expect(events.filter((event) => event.subtype === "started")).toHaveLength(1);
	});
});
