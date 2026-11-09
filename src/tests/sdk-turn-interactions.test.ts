import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionNotification,
} from "@agentclientprotocol/sdk";
import { CursorAcpAgent } from "../cursor-acp-agent.js";
import type { CursorAcpClient } from "../cursor-acp-client.js";
import type { CursorRunner, CursorStreamEvent, RunPromptOptions } from "../cursor-runner.js";
import { initRequest, newSessionRequest, noopLogger } from "./test-support.js";

const models = [
	{ modelId: "auto", name: "Auto", current: true },
	{
		modelId: "composer-2.5",
		name: "Composer 2.5",
		parameters: [
			{
				id: "fast",
				type: "boolean" as const,
				default: "false",
				values: [
					{ value: "true", displayName: "On" },
					{ value: "false", displayName: "Off" },
				],
			},
		],
	},
];

class FakeClient implements CursorAcpClient {
	permissions: RequestPermissionRequest[] = [];
	async sessionUpdate(_update: SessionNotification) {}
	async requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		this.permissions.push(request);
		return { outcome: { outcome: "selected", optionId: "allow_once" } };
	}
	async extMethod() {
		return {};
	}
	async extNotification() {}
	async readTextFile() {
		return { content: "" };
	}
	async writeTextFile() {
		return {};
	}
}

function harness() {
	const client = new FakeClient();
	const prompts: RunPromptOptions[] = [];
	const steers: string[] = [];
	let events: CursorStreamEvent[] = [];
	let hold = false;
	let release: (() => void) | undefined;
	const runner: CursorRunner = {
		supportsMidTurnSteering: true,
		listModels: async () => models,
		createChat: async () => "agent-created",
		startPrompt(options) {
			prompts.push(options);
			const runEvents = events;
			events = [];
			const completed = (async () => {
				if (hold)
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				for (const event of runEvents) await options.onEvent?.(event);
				return {
					events: runEvents,
					resultEvent: { type: "result", subtype: "success", is_error: false },
					stderr: "",
					exitCode: 0,
				};
			})();
			return {
				completed,
				cancel() {},
				steer: async (text: string) => {
					steers.push(text);
					return "complete_delivered" as const;
				},
			};
		},
	};
	const agent = new CursorAcpAgent(client, {
		runner,
		logger: noopLogger,
		auth: {
			status: async () => ({ loggedIn: true, account: "test", raw: "" }),
			ensureLoggedIn: async () => ({ loggedIn: true, account: "test", raw: "" }),
			login: async () => ({ code: 0, stdout: "", stderr: "" }),
			logout: async () => ({ code: 0, stdout: "", stderr: "" }),
		},
	});
	return {
		agent,
		client,
		prompts,
		steers,
		setEvents(next: CursorStreamEvent[]) {
			events = next;
		},
		block() {
			hold = true;
		},
		unblock() {
			hold = false;
			release?.();
		},
	};
}

let workspace: string;
const previousConfigDir = process.env.CURSOR_ACP_CONFIG_DIR;
beforeEach(async () => {
	workspace = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-turn-test-"));
	process.env.CURSOR_ACP_CONFIG_DIR = workspace;
});
afterEach(async () => {
	if (previousConfigDir === undefined) delete process.env.CURSOR_ACP_CONFIG_DIR;
	else process.env.CURSOR_ACP_CONFIG_DIR = previousConfigDir;
	await rm(workspace, { recursive: true, force: true });
});

describe("SDK turn interactions", () => {
	it("applies a Fast change after a cancelled SDK run drains", async () => {
		const h = harness();
		await h.agent.initialize(initRequest());
		const { sessionId } = await h.agent.newSession(
			newSessionRequest({ cwd: workspace, default_model: "composer-2.5" }),
		);
		await h.agent.setSessionConfigOption({ sessionId, configId: "fast", value: "true" });
		h.block();
		const first = h.agent.prompt({ sessionId, prompt: [{ type: "text", text: "first" }] });
		await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
		expect(h.prompts[0]?.fastValue).toBe("true");
		await h.agent.cancel({ sessionId });
		expect(await first).toEqual({ stopReason: "cancelled" });
		let applied = false;
		const change = h.agent
			.setSessionConfigOption({
				sessionId,
				configId: "fast",
				value: "false",
			})
			.then((value) => {
				applied = true;
				return value;
			});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(applied).toBe(false);
		h.unblock();
		await change;
		await h.agent.prompt({ sessionId, prompt: [{ type: "text", text: "next" }] });
		expect(h.prompts[1]?.fastValue).toBe("false");
	});

	it("includes a delivered steer in an approved tool retry", async () => {
		const h = harness();
		await h.agent.initialize(initRequest());
		const { sessionId } = await h.agent.newSession(newSessionRequest({ cwd: workspace }));
		h.setEvents([
			{
				type: "tool_call",
				subtype: "started",
				call_id: "call_1",
				tool_call: { shellToolCall: { args: { command: "pwd" } } },
			},
			{
				type: "tool_call",
				subtype: "completed",
				call_id: "call_1",
				tool_call: {
					shellToolCall: {
						args: { command: "pwd" },
						result: { rejected: { message: "auto-approval boundary" } },
					},
				},
			},
		]);
		h.block();
		const first = h.agent.prompt({ sessionId, prompt: [{ type: "text", text: "first" }] });
		await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
		const steer = h.agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "more detail" }],
		});
		await vi.waitFor(() => expect(h.steers).toEqual(["more detail"]));
		h.unblock();
		await Promise.all([first, steer]);
		expect(h.client.permissions).toHaveLength(1);
		expect(h.prompts.map((p) => p.prompt)).toEqual(["first", "first\n\nmore detail"]);
		expect(h.prompts[1]?.reviewPolicy).toBe("run-everything");
	});
});
