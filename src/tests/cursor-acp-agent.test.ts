import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	PromptResponse,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionNotification,
} from "@agentclientprotocol/sdk";
import type {
	ExtendedLoadSessionResponse,
	ExtendedNewSessionResponse,
} from "../legacy-session-models.js";
import {
	CreateNativeSessionOptions,
	NativeModeId,
	NativeSessionBackend,
	NativeSessionCallbacks,
} from "../cursor-native-acp-client.js";
import { CursorAcpAgent } from "../cursor-acp-agent.js";
import type { CursorAcpClient } from "../cursor-acp-client.js";
import type { RunPromptOptions } from "../cursor-cli-runner.js";
import { steerSessionDir } from "../steer-attachments.js";
import {
	recordAssistantMessage,
	recordSessionMeta,
	recordUserMessage,
} from "../session-storage.js";
import type { PermissionModeSetting } from "../settings.js";
import type { CursorModelDescriptor } from "../slash-commands.js";
import {
	agentTestAccess,
	ensureNativeBackend,
	getSessionState,
	initRequest,
	newSessionRequest,
} from "./test-support.js";
import type { LegacyPromptHandler, TestCliRunner } from "./test-support.js";

/** Minimal image payload used to exercise steer attachment conversion. */
const PNG_STEER_ATTACHMENT = Buffer.from("steer-attachment-image-bytes").toString("base64");

/** Permission bits of a file or directory, as seen by the current user. */
async function statMode(target: string): Promise<number> {
	return (await stat(target)).mode & 0o777;
}

class FakeClient implements CursorAcpClient {
	updates: SessionNotification[] = [];
	permissionCalls: RequestPermissionRequest[] = [];
	extMethodCalls: { method: string; params: Record<string, unknown> }[] = [];
	extNotificationCalls: { method: string; params: Record<string, unknown> }[] = [];
	extMethodResponses: Record<string, Record<string, unknown>> = {};

	async sessionUpdate(params: SessionNotification): Promise<void> {
		this.updates.push(params);
	}

	async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		this.permissionCalls.push(params);
		const allowOption = params.options.find((option) => option.kind.startsWith("allow"));
		return {
			outcome: {
				outcome: "selected",
				optionId: allowOption?.optionId ?? params.options[0]?.optionId ?? "allow-once",
			},
		};
	}

	async extMethod(
		method: string,
		params: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		this.extMethodCalls.push({ method, params });
		return this.extMethodResponses[method] ?? {};
	}

	async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
		this.extNotificationCalls.push({ method, params });
	}

	async readTextFile(): Promise<{ content: string }> {
		return { content: "" };
	}

	async writeTextFile(): Promise<Record<string, never>> {
		return {};
	}
}

class FakeNativeBackend implements NativeSessionBackend {
	alive = true;
	closeCalls = 0;
	createCalls = 0;
	loadCalls: string[] = [];
	modeCalls: NativeModeId[] = [];
	modelCalls: string[] = [];
	nativeSessionId: string | undefined;
	promptCalls: string[] = [];
	promptHandler?: (promptText: string) => Promise<PromptResponse>;

	constructor(
		readonly options: CreateNativeSessionOptions,
		readonly callbacks: NativeSessionCallbacks,
		private readonly index: number,
		private readonly backendOptions: {
			createCurrentModelId?: string;
			createCurrentModeId?: NativeModeId;
			createSessionBlocker?: Promise<void>;
			createSessionBlockers?: Array<Promise<void> | undefined>;
		} = {},
	) {
		this.nativeSessionId = `native-${index}`;
	}

	async cancel(): Promise<void> {}

	async close(): Promise<void> {
		this.alive = false;
		this.closeCalls += 1;
	}

	async createSessionBackend(): Promise<ExtendedNewSessionResponse> {
		this.createCalls += 1;
		await (this.backendOptions.createSessionBlocker ??
			this.backendOptions.createSessionBlockers?.[this.index - 1]);
		const currentModelId =
			this.backendOptions.createCurrentModelId ?? this.options.modelId ?? "auto";
		await this.callbacks.onSessionUpdate({
			sessionId: this.nativeSessionId!,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands: [
					{ name: "commit", description: "Commit helper", input: null },
					{ name: "mode", description: "Native mode", input: null },
				],
			},
		});

		return {
			sessionId: this.nativeSessionId!,
			models: {
				currentModelId,
				availableModels: [
					{
						modelId: currentModelId,
						name: currentModelId === "auto" ? "Auto" : currentModelId,
						description: currentModelId === "auto" ? "Auto" : currentModelId,
					},
				],
			},
			modes: {
				currentModeId: this.backendOptions.createCurrentModeId ?? "agent",
				availableModes: [
					{ id: "agent", name: "Agent", description: "Agent mode" },
					{ id: "plan", name: "Plan", description: "Plan mode" },
					{ id: "ask", name: "Ask", description: "Ask mode" },
				],
			},
		};
	}

	async loadSessionBackend(nativeSessionId: string): Promise<ExtendedLoadSessionResponse> {
		this.loadCalls.push(nativeSessionId);
		this.nativeSessionId = nativeSessionId;
		await this.callbacks.onSessionUpdate({
			sessionId: this.nativeSessionId!,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands: [
					{ name: "commit", description: "Commit helper", input: null },
					{ name: "mode", description: "Native mode", input: null },
				],
			},
		});

		return {
			models: {
				currentModelId: "gpt-5.4-medium",
				availableModels: [
					{ modelId: "gpt-5.4-medium", name: "GPT-5.4", description: "GPT-5.4" },
					{
						modelId: "gpt-5.4-medium-fast",
						name: "GPT-5.4 Fast",
						description: "GPT-5.4 Fast",
					},
					{ modelId: "gpt-5.2", name: "GPT-5.2", description: "GPT-5.2" },
				],
			},
			modes: {
				currentModeId: "agent",
				availableModes: [
					{ id: "agent", name: "Agent", description: "Agent mode" },
					{ id: "plan", name: "Plan", description: "Plan mode" },
					{ id: "ask", name: "Ask", description: "Ask mode" },
				],
			},
		};
	}

	async prompt(promptText: string): Promise<PromptResponse> {
		this.promptCalls.push(promptText);
		if (this.promptHandler) {
			return await this.promptHandler(promptText);
		}

		return { stopReason: "end_turn" };
	}

	async restartBackend(): Promise<ExtendedNewSessionResponse> {
		return await this.createSessionBackend();
	}

	async setNativeMode(modeId: NativeModeId): Promise<Record<string, never>> {
		this.modeCalls.push(modeId);
		await this.callbacks.onSessionUpdate({
			sessionId: this.nativeSessionId!,
			update: {
				sessionUpdate: "current_mode_update",
				currentModeId: modeId,
			},
		});
		return {};
	}

	async setNativeModel(modelId: string): Promise<Record<string, never>> {
		this.modelCalls.push(modelId);
		return {};
	}

	/** Simulate native `agent acp` invoking a Cursor extension RPC toward the client. */
	async simulateNativeExtMethod(
		method: string,
		params: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		if (!this.callbacks.onExtMethod) {
			throw new Error("onExtMethod not wired");
		}

		return await this.callbacks.onExtMethod(method, params);
	}

	async simulateNativeExtNotification(
		method: string,
		params: Record<string, unknown>,
	): Promise<void> {
		if (!this.callbacks.onExtNotification) {
			throw new Error("onExtNotification not wired");
		}

		await this.callbacks.onExtNotification(method, params);
	}
}

function createAgentTestHarness(
	backendOptions: {
		createCurrentModelId?: string;
		createCurrentModeId?: NativeModeId;
		createSessionBlocker?: Promise<void>;
		createSessionBlockers?: Array<Promise<void> | undefined>;
		models?: CursorModelDescriptor[];
		permissionMode?: PermissionModeSetting;
		supportsSteering?: boolean;
		listModels?: () => Promise<CursorModelDescriptor[]>;
	} = {},
) {
	const backends: FakeNativeBackend[] = [];
	const client = new FakeClient();
	let legacyPromptHandler: LegacyPromptHandler | undefined;
	let steerHandler:
		| ((text: string) => Promise<"complete_delivered" | "revert_to_followup">)
		| undefined;
	const steerCalls: string[] = [];
	const legacyPromptCalls: {
		promptText: string;
		images?: RunPromptOptions["images"];
		backendSessionId?: string;
		modelId?: string;
		reviewPolicy?: RunPromptOptions["reviewPolicy"];
		thinkingLevel?: string;
		fastValue?: string;
	}[] = [];

	const runner: TestCliRunner = {
		supportsMidTurnSteering: backendOptions.supportsSteering,
		async createChat() {
			return "legacy-chat-1";
		},
		async listModels() {
			if (backendOptions.listModels) return await backendOptions.listModels();
			return (
				backendOptions.models ?? [
					{ modelId: "auto", name: "Auto", current: true },
					{ modelId: "gpt-5.4-medium", name: "GPT-5.4" },
					{ modelId: "gpt-5.4-medium-fast", name: "GPT-5.4 Fast" },
					{ modelId: "gpt-5.2", name: "GPT-5.2" },
					{ modelId: "claude-4.5-opus-high", name: "Opus 4.5" },
				]
			);
		},
		startPrompt(options: RunPromptOptions) {
			legacyPromptCalls.push({
				promptText: options.prompt,
				images: options.images,
				backendSessionId: options.backendSessionId,
				modelId: options.modelId,
				reviewPolicy: options.reviewPolicy,
				thinkingLevel: options.thinkingLevel,
				fastValue: options.fastValue,
			});
			const completed = (async () => {
				if (legacyPromptHandler) {
					return await legacyPromptHandler(options.prompt, {
						backendSessionId: options.backendSessionId,
						reviewPolicy: options.reviewPolicy,
						onEvent: options.onEvent,
					});
				}
				return {
					events: [],
					resultEvent: { type: "result", subtype: "success", is_error: false },
					stderr: "",
					exitCode: 0,
				};
			})();
			return {
				completed,
				cancel() {},
				...(backendOptions.supportsSteering
					? {
							steer: async (text: string) => {
								steerCalls.push(text);
								return await (steerHandler?.(text) ?? "complete_delivered");
							},
						}
					: {}),
			};
		},
	};

	const agent = new CursorAcpAgent(client, {
		permissionMode: backendOptions.permissionMode,
		auth: {
			async status() {
				return { loggedIn: true as const, account: "u@e", raw: "" };
			},
			async ensureLoggedIn() {
				return { loggedIn: true as const, account: "u@e", raw: "" };
			},
			async login() {
				return { code: 0, stdout: "", stderr: "" };
			},
			async logout() {
				return { code: 0, stdout: "", stderr: "" };
			},
		},
		runner,
		createNativeClient(options, callbacks) {
			const backend = new FakeNativeBackend(
				options,
				callbacks,
				backends.length + 1,
				backendOptions,
			);
			backends.push(backend);
			return backend;
		},
	});

	return {
		agent,
		backends,
		client,
		legacyPromptCalls,
		steerCalls,
		setSteerHandler(handler: NonNullable<typeof steerHandler>) {
			steerHandler = handler;
		},
		setLegacyPromptHandler(handler: LegacyPromptHandler) {
			legacyPromptHandler = handler;
		},
	};
}

function createLoggedOutAgentTestHarness() {
	const backends: FakeNativeBackend[] = [];
	const client = new FakeClient();

	const agent = new CursorAcpAgent(client, {
		auth: {
			async status() {
				return { loggedIn: false as const, raw: "" };
			},
			async ensureLoggedIn() {
				return { loggedIn: false as const, raw: "" };
			},
			async login() {
				return { code: 0, stdout: "", stderr: "" };
			},
			async logout() {
				return { code: 0, stdout: "", stderr: "" };
			},
		},
		runner: {
			async listModels() {
				return [{ modelId: "auto", name: "Auto", current: true }];
			},
			async createChat() {
				return "legacy-chat-1";
			},
			startPrompt() {
				return {
					completed: Promise.resolve({
						events: [],
						resultEvent: { type: "result", subtype: "success", is_error: false },
						stderr: "",
						exitCode: 0,
					}),
					cancel() {},
				};
			},
		},
		createNativeClient(options, callbacks) {
			const backend = new FakeNativeBackend(options, callbacks, backends.length + 1);
			backends.push(backend);
			return backend;
		},
	});

	return { agent, backends, client };
}

async function startNativeBackend(agent: CursorAcpAgent, sessionId: string): Promise<void> {
	await ensureNativeBackend(agent, sessionId);
}

async function waitForScheduledUpdates(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

const originalCursorAcpConfigDir = process.env.CURSOR_ACP_CONFIG_DIR;
let tempConfigDir: string | undefined;

beforeEach(async () => {
	tempConfigDir = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-agent-config-"));
	process.env.CURSOR_ACP_CONFIG_DIR = tempConfigDir;
});

describe("1M context model selection", () => {
	it("advertises a 1M entry and restores a /model selection after load", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-context-state-"));
		process.env.CURSOR_ACP_CONFIG_DIR = tempRoot;
		const models: CursorModelDescriptor[] = [
			{ modelId: "auto", name: "Auto", current: true },
			{
				modelId: "claude-sonnet-4-6",
				name: "Claude Sonnet 4.6",
				parameters: [{ id: "context", values: [{ value: "300k" }, { value: "1m" }] }],
			},
		];
		try {
			const first = createAgentTestHarness({ models });
			await first.agent.initialize(initRequest());
			const created = await first.agent.newSession(
				newSessionRequest({ cwd: "/tmp/context-project" }),
			);
			expect(created.models?.availableModels.map((model) => model.modelId)).toContain(
				"claude-sonnet-4-6[context=1m]",
			);
			await first.agent.prompt({
				sessionId: created.sessionId,
				prompt: [{ type: "text", text: "/model auto[context=1m]" }],
			});
			expect(agentTestAccess(first.agent).sessions[created.sessionId]?.modelId).toBe("auto");
			await first.agent.prompt({
				sessionId: created.sessionId,
				prompt: [{ type: "text", text: "/model claude-sonnet-4-6[context=1m]" }],
			});
			expect(agentTestAccess(first.agent).sessions[created.sessionId]?.modelId).toBe(
				"claude-sonnet-4-6[context=1m]",
			);

			const second = createAgentTestHarness({ models });
			await second.agent.initialize(initRequest());
			const loaded = await second.agent.loadSession({
				sessionId: created.sessionId,
				cwd: "/tmp/context-project",
				mcpServers: [],
			});
			expect(loaded.models?.currentModelId).toBe("claude-sonnet-4-6[context=1m]");
			expect(
				loaded.models?.availableModels.filter(
					(model) => model.modelId === "claude-sonnet-4-6[context=1m]",
				),
			).toHaveLength(1);
			expect(loaded.configOptions?.find((option) => option.id === "model")).toMatchObject({
				currentValue: "claude-sonnet-4-6[context=1m]",
			});
		} finally {
			delete process.env.CURSOR_ACP_CONFIG_DIR;
			await rm(tempRoot, { recursive: true, force: true });
		}
	});
});

describe("model discovery failures", () => {
	it("rejects a failed discovery instead of advertising Auto and recovers on retry", async () => {
		const listModels = vi
			.fn<() => Promise<CursorModelDescriptor[]>>()
			.mockRejectedValueOnce(new Error("Model catalog unavailable"))
			.mockResolvedValueOnce([{ modelId: "composer-2.5", name: "Composer 2.5" }]);
		const { agent } = createAgentTestHarness({ listModels });
		await agent.initialize(initRequest());
		await expect(agent.newSession(newSessionRequest())).rejects.toThrow(
			"Model catalog unavailable",
		);
		const session = await agent.newSession(newSessionRequest());
		expect(session.models?.availableModels).toEqual(
			expect.arrayContaining([expect.objectContaining({ modelId: "composer-2.5" })]),
		);
	});
});

afterEach(async () => {
	if (originalCursorAcpConfigDir) {
		process.env.CURSOR_ACP_CONFIG_DIR = originalCursorAcpConfigDir;
	} else {
		delete process.env.CURSOR_ACP_CONFIG_DIR;
	}
	if (tempConfigDir) {
		await rm(tempConfigDir, { recursive: true, force: true });
		tempConfigDir = undefined;
	}
});

describe("CursorAcpAgent", () => {
	it("applies the permission mode setting to new and restored agent sessions while preserving ask and plan", async () => {
		const full = createAgentTestHarness({ permissionMode: "full" });
		await full.agent.initialize(initRequest());
		const newSession = await full.agent.newSession(
			newSessionRequest({ cwd: "/tmp/permission-setting" }),
		);
		expect(newSession.modes?.currentModeId).toBe("yolo");
		await full.agent.prompt({
			sessionId: newSession.sessionId,
			prompt: [{ type: "text", text: "hi" }],
		});
		expect(full.legacyPromptCalls[full.legacyPromptCalls.length - 1]?.reviewPolicy).toBe(
			"run-everything",
		);

		await recordUserMessage("/tmp/permission-setting", "setting-restored", "prior prompt");
		await recordSessionMeta("/tmp/permission-setting", "setting-restored", { modeId: "yolo" });
		const restricted = createAgentTestHarness({ permissionMode: "accept-edits" });
		await restricted.agent.initialize(initRequest());
		const restrictedNew = await restricted.agent.newSession(
			newSessionRequest({ cwd: "/tmp/permission-setting" }),
		);
		expect(restrictedNew.modes?.currentModeId).toBe("accept-edits");
		const restored = await restricted.agent.loadSession({
			sessionId: "setting-restored",
			cwd: "/tmp/permission-setting",
		});
		expect(restored.modes?.currentModeId).toBe("accept-edits");
		await restricted.agent.prompt({
			sessionId: "setting-restored",
			prompt: [{ type: "text", text: "hi" }],
		});
		expect(
			restricted.legacyPromptCalls[restricted.legacyPromptCalls.length - 1]?.reviewPolicy,
		).toBe("workspace-sandbox");
		await expect(
			restricted.agent.setSessionMode({ sessionId: "setting-restored", modeId: "yolo" }),
		).rejects.toThrow();
		await restricted.agent.setSessionMode({
			sessionId: "setting-restored",
			modeId: "auto-review",
		});
		await restricted.agent.prompt({
			sessionId: "setting-restored",
			prompt: [{ type: "text", text: "reviewed" }],
		});
		expect(
			restricted.legacyPromptCalls[restricted.legacyPromptCalls.length - 1]?.reviewPolicy,
		).toBe("sandbox-auto-review");

		await recordUserMessage("/tmp/permission-setting", "setting-plan", "prior prompt");
		await recordSessionMeta("/tmp/permission-setting", "setting-plan", { modeId: "plan" });
		const plan = await restricted.agent.unstable_resumeSession({
			sessionId: "setting-plan",
			cwd: "/tmp/permission-setting",
			mcpServers: [],
		});
		expect(plan.modes?.currentModeId).toBe("plan");
		await restricted.agent.prompt({
			sessionId: "setting-plan",
			prompt: [{ type: "text", text: "plan" }],
		});
		expect(
			restricted.legacyPromptCalls[restricted.legacyPromptCalls.length - 1]?.reviewPolicy,
		).toBe("sandbox-auto-review");
	});
	it("handles adapter slash commands without invoking native prompt", async () => {
		const { agent, client, legacyPromptCalls } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);

		const response = await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "/status" }],
		});

		expect(response.stopReason).toBe("end_turn");
		expect(legacyPromptCalls).toHaveLength(0);
		expect(client.updates.some((u) => u.update?.sessionUpdate === "agent_message_chunk")).toBe(
			true,
		);
	});

	it("advertises builtin slash commands during newSession without starting native ACP", async () => {
		const { agent, backends, client } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);
		await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);
		await waitForScheduledUpdates();

		expect(backends).toHaveLength(0);
		const commandsUpdate = client.updates.find(
			(update) => update.update?.sessionUpdate === "available_commands_update",
		);
		const names =
			commandsUpdate?.update.sessionUpdate === "available_commands_update"
				? commandsUpdate.update.availableCommands.map((command) => command.name)
				: undefined;
		expect(names ?? []).toContain("help");
		expect(names ?? []).toContain("mode");
	});

	it("forwards colliding slash commands to the native backend", async () => {
		const { agent, legacyPromptCalls } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);
		await startNativeBackend(agent, session.sessionId);

		const response = await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "/mode plan" }],
		});

		expect(response.stopReason).toBe("end_turn");
		expect(legacyPromptCalls.map((call) => call.promptText)).toEqual(["/mode plan"]);
		expect(agentTestAccess(agent).sessions[session.sessionId]?.modeId).toBe("auto-review");
	});

	it("forwards native slash commands when advertised with a leading slash", async () => {
		const { agent, legacyPromptCalls } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);
		await startNativeBackend(agent, session.sessionId);

		agentTestAccess(agent).sessions[session.sessionId].nativeAvailableCommands = [
			{ name: "/mode", description: "Native mode", input: null },
		];

		const response = await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "/mode ask" }],
		});

		expect(response.stopReason).toBe("end_turn");
		expect(legacyPromptCalls.map((call) => call.promptText)).toEqual(["/mode ask"]);
	});

	it("forwards native mcp slash commands across equivalent spellings", async () => {
		const { agent, legacyPromptCalls } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);
		await startNativeBackend(agent, session.sessionId);

		agentTestAccess(agent).sessions[session.sessionId].nativeAvailableCommands = [
			{ name: "mcp:github:issue", description: "MCP issue helper", input: null },
		];

		const response = await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "/mcp:github:issue 123" }],
		});

		expect(response.stopReason).toBe("end_turn");
		expect(legacyPromptCalls.map((call) => call.promptText)).toEqual(["/mcp:github:issue 123"]);
	});

	it("merges native available commands with wrapper built-ins", async () => {
		const { agent, client } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);
		await startNativeBackend(agent, session.sessionId);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const commandsUpdate = client.updates.find(
			(update) => update.update?.sessionUpdate === "available_commands_update",
		);
		const names =
			commandsUpdate?.update.sessionUpdate === "available_commands_update"
				? commandsUpdate.update.availableCommands.map((command) => command.name)
				: undefined;
		expect(names ?? []).toContain("help");
		expect(names ?? []).toContain("mode");
		expect(names ?? []).toContain("commit");
		expect((names ?? []).filter((name) => name === "mode")).toHaveLength(1);
	});

	it("advertises custom slash commands and skills with native command updates", async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-commands-"));
		await mkdir(path.join(workspace, ".cursor", "commands"), { recursive: true });
		await mkdir(path.join(workspace, ".cursor", "skills", "workspace-skill"), {
			recursive: true,
		});
		await writeFile(
			path.join(workspace, ".cursor", "commands", "review-local.md"),
			["---", "description: Review local changes", "---", "Review $ARGUMENTS"].join("\n"),
			"utf8",
		);
		await writeFile(
			path.join(workspace, ".cursor", "skills", "workspace-skill", "SKILL.md"),
			[
				"---",
				"name: workspace-skill",
				"description: Workspace skill",
				"---",
				"Use workspace skill.",
			].join("\n"),
			"utf8",
		);

		try {
			const { agent, client } = createAgentTestHarness();

			await agent.initialize(
				initRequest({
					protocolVersion: 1,
					clientCapabilities: {},
				}),
			);
			await agent.newSession(
				newSessionRequest({
					cwd: workspace,
					mcpServers: [],
				}),
			);
			await waitForScheduledUpdates();

			const commandsUpdate = client.updates.find(
				(update) => update.update?.sessionUpdate === "available_commands_update",
			);
			const names =
				commandsUpdate?.update.sessionUpdate === "available_commands_update"
					? commandsUpdate.update.availableCommands.map((command) => command.name)
					: [];

			expect(names).toContain("review-local");
			expect(names).toContain("workspace-skill");
			expect(names).toContain("help");
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("expands custom slash commands and passes skill path and trailing request to Cursor", async () => {
		const workspace = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-prompts-"));
		await mkdir(path.join(workspace, ".cursor", "commands"), { recursive: true });
		await mkdir(path.join(workspace, ".cursor", "skills", "workspace-skill"), {
			recursive: true,
		});
		await writeFile(
			path.join(workspace, ".cursor", "commands", "review-local.md"),
			"Review these changes: $ARGUMENTS",
			"utf8",
		);
		await writeFile(
			path.join(workspace, ".cursor", "skills", "workspace-skill", "SKILL.md"),
			[
				"---",
				"name: workspace-skill",
				"description: Workspace skill",
				"---",
				"Skill body",
			].join("\n"),
			"utf8",
		);

		try {
			const { agent, legacyPromptCalls } = createAgentTestHarness();

			await agent.initialize(
				initRequest({
					protocolVersion: 1,
					clientCapabilities: {},
				}),
			);
			const session = await agent.newSession(
				newSessionRequest({
					cwd: workspace,
					mcpServers: [],
				}),
			);

			await agent.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "/review-local src" }],
			});
			await agent.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "/workspace-skill inspect deck.html" }],
			});
			await agent.prompt({
				sessionId: session.sessionId,
				prompt: [
					{
						type: "text",
						text: "<system_instructions>BB context</system_instructions>\n\n/workspace-skill check slides.html",
					},
				],
			});

			expect(legacyPromptCalls.map((call) => call.promptText)).toEqual([
				"Review these changes: src",
				`Skill file: ${path.join(workspace, ".cursor", "skills", "workspace-skill", "SKILL.md")}\nSkill directory: ${path.join(workspace, ".cursor", "skills", "workspace-skill")}\n\nSkill body\n\ninspect deck.html`,
				`<system_instructions>BB context</system_instructions>\n\nSkill file: ${path.join(workspace, ".cursor", "skills", "workspace-skill", "SKILL.md")}\nSkill directory: ${path.join(workspace, ".cursor", "skills", "workspace-skill")}\n\nSkill body\n\ncheck slides.html`,
			]);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("forwards native Cursor extension methods to the outer client with wrapper session id", async () => {
		const { agent, backends, client } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);
		await startNativeBackend(agent, session.sessionId);

		client.extMethodResponses["cursor/ask_question"] = { picked: "a" };
		const backend = backends[0]!;
		const result = await backend.simulateNativeExtMethod("cursor/ask_question", {
			sessionId: backend.nativeSessionId,
			questionId: "q1",
		});

		expect(result).toEqual({ picked: "a" });
		expect(client.extMethodCalls).toEqual([
			{
				method: "cursor/ask_question",
				params: { sessionId: session.sessionId, questionId: "q1" },
			},
		]);

		await backend.simulateNativeExtNotification("cursor/update_todos", {
			sessionId: backend.nativeSessionId,
			todos: [],
		});
		expect(client.extNotificationCalls).toEqual([
			{
				method: "cursor/update_todos",
				params: { sessionId: session.sessionId, todos: [] },
			},
		]);
	});

	it("creates sessions before auth and defers native backend startup until first prompt", async () => {
		const { agent, backends } = createLoggedOutAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);

		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);

		expect(session.models?.currentModelId).toBe("auto");
		expect(backends).toHaveLength(0);

		await expect(
			agent.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "hello" }],
			}),
		).rejects.toThrow("Authentication required");

		expect(backends).toHaveLength(0);
	});

	it("exposes listed models in newSession model listing", async () => {
		const { agent } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);

		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);

		expect(session.models?.currentModelId).toBe("auto");
		expect(session.models?.availableModels.map((model) => model.modelId)).toEqual([
			"auto",
			"gpt-5.4-medium",
			"gpt-5.4-medium-fast",
			"gpt-5.2",
			"claude-4.5-opus-high",
		]);
	});

	it("returns newSession without starting native backend warm-up", async () => {
		let unblockWarmup!: () => void;
		const createSessionBlocker = new Promise<void>((resolve) => {
			unblockWarmup = resolve;
		});
		const { agent, backends } = createAgentTestHarness({ createSessionBlocker });

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);

		const newSessionPromise = agent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		});

		await new Promise((resolve) => setTimeout(resolve, 0));

		await expect(
			Promise.race([
				newSessionPromise.then((session) => session.models?.currentModelId),
				new Promise((resolve) => setTimeout(() => resolve("blocked"), 200)),
			]),
		).resolves.toBe("auto");
		expect(backends).toHaveLength(0);

		unblockWarmup();
		await newSessionPromise;
		await waitForScheduledUpdates();
	});

	it("prefers CLI model ids over native config-style model ids to avoid duplicates", async () => {
		const { agent } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);

		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);

		const internalSession = agentTestAccess(agent).sessions[session.sessionId];
		await agentTestAccess(agent).applyNativeSessionModelsAndModes(internalSession, {
			models: {
				currentModelId: "default[]",
				availableModels: [
					{ modelId: "default[]", name: "default", description: "default" },
					{
						modelId: "gpt-5.4[reasoning=medium,context=272k,fast=false]",
						name: "gpt-5.4",
						description: "gpt-5.4",
					},
					{
						modelId: "gpt-5.4-mini[reasoning=medium]",
						name: "gpt-5.4-mini",
						description: "gpt-5.4-mini",
					},
				],
			},
		});

		expect(internalSession.nativeSessionModels?.currentModelId).toBe("auto");
		expect(
			internalSession.nativeSessionModels?.availableModels.map((model) => model.modelId),
		).toEqual([
			"auto",
			"gpt-5.4-medium",
			"gpt-5.4-medium-fast",
			"gpt-5.2",
			"claude-4.5-opus-high",
		]);
	});

	it("uses auto-review mode by default", async () => {
		const { agent } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);

		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);

		expect(session.modes?.currentModeId).toBe("auto-review");
	});

	it("honors requested auto-review mode when creating a new session", async () => {
		const { agent, client, legacyPromptCalls } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);

		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
				modeId: "auto-review",
			}),
		);

		expect(session.modes?.currentModeId).toBe("auto-review");
		expect(session.modes?.availableModes?.map((mode) => mode.id)).toEqual([
			"auto-review",
			"accept-edits",
			"yolo",
			"ask",
			"plan",
		]);

		await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "run pwd" }],
		});

		expect(legacyPromptCalls[0]).toMatchObject({
			reviewPolicy: "auto-review",
		});
		expect(client.permissionCalls).toHaveLength(0);
	});

	it("honors requested yolo mode when creating a new session", async () => {
		const { agent, backends, client } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);

		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
				modeId: "yolo",
			}),
		);

		expect(session.modes?.currentModeId).toBe("yolo");

		await startNativeBackend(agent, session.sessionId);
		backends[0]!.promptHandler = async () => {
			const response = await backends[0]!.callbacks.onRequestPermission({
				sessionId: backends[0]!.nativeSessionId!,
				options: [
					{
						optionId: "allow-always",
						kind: "allow_always",
						name: "Always allow",
					},
				],
				toolCall: {
					toolCallId: "t1",
					title: "`pwd`",
					rawInput: { command: "pwd" },
				},
			});
			expect(response).toMatchObject({
				outcome: {
					outcome: "selected",
					optionId: "allow-always",
				},
			});
			return { stopReason: "end_turn" };
		};

		await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "run pwd" }],
		});

		expect(client.permissionCalls).toHaveLength(0);
	});

	it("accepts snake_case default_mode from ACP clients", async () => {
		const { agent, backends, client } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);

		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
				default_mode: "yolo",
			}),
		);

		expect(session.modes?.currentModeId).toBe("yolo");

		await startNativeBackend(agent, session.sessionId);
		backends[0]!.promptHandler = async () => {
			const response = await backends[0]!.callbacks.onRequestPermission({
				sessionId: backends[0]!.nativeSessionId!,
				options: [
					{
						optionId: "allow-always",
						kind: "allow_always",
						name: "Always allow",
					},
				],
				toolCall: {
					toolCallId: "t1",
					title: "`pwd`",
					rawInput: { command: "pwd" },
				},
			});
			expect(response).toMatchObject({
				outcome: {
					outcome: "selected",
					optionId: "allow-always",
				},
			});
			return { stopReason: "end_turn" };
		};

		await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "run pwd" }],
		});

		expect(client.permissionCalls).toHaveLength(0);
	});

	it("accepts snake_case default_model from ACP clients", async () => {
		const { agent, backends } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);

		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
				default_model: "gpt-5.2",
			}),
		);

		expect(session.models?.currentModelId).toBe("gpt-5.2");

		await startNativeBackend(agent, session.sessionId);
		expect(backends[0]!.options.modelId).toBe("gpt-5.2");
	});

	it("normalizes legacy default_model syntax from ACP clients", async () => {
		const { agent, backends } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);

		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
				default_model: "gpt-5.4-medium[fast=true]",
			}),
		);

		expect(session.models?.currentModelId).toBe("gpt-5.4-medium-fast");

		await startNativeBackend(agent, session.sessionId);
		expect(backends[0]!.options.modelId).toBe("gpt-5.4-medium-fast");
	});

	it("accepts default_config_options mode and model from ACP clients", async () => {
		const { agent } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);

		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
				default_config_options: {
					mode: "yolo",
					model: "gpt-5.2",
				},
			}),
		);

		expect(session.modes?.currentModeId).toBe("yolo");
		expect(session.models?.currentModelId).toBe("gpt-5.2");
		expect(session.configOptions?.find((option) => option.id === "mode")?.currentValue).toBe(
			"yolo",
		);
		expect(session.configOptions?.find((option) => option.id === "model")?.currentValue).toBe(
			"gpt-5.2",
		);
	});

	it("accepts fast and thinking defaults from ACP config options", async () => {
		const { agent, backends } = createAgentTestHarness({
			models: [
				{ modelId: "auto", name: "Auto", current: true },
				{ modelId: "gpt-5.4-medium", name: "GPT-5.4" },
				{ modelId: "gpt-5.4-medium-fast", name: "GPT-5.4 Fast" },
				{ modelId: "gpt-5.4-high", name: "GPT-5.4 High" },
				{ modelId: "gpt-5.4-high-fast", name: "GPT-5.4 High Fast" },
			],
		});

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);

		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
				default_config_options: {
					model: "gpt-5.4-medium",
					thinking: "high",
					fast: "true",
				},
			}),
		);

		expect(session.models?.currentModelId).toBe("gpt-5.4-high-fast");
		expect(session.configOptions?.find((option) => option.id === "thinking")).toMatchObject({
			currentValue: "high",
			category: "thought_level",
		});
		expect(session.configOptions?.find((option) => option.id === "fast")).toMatchObject({
			currentValue: "true",
			category: "model_config",
		});
		expect(session.configOptions?.map((option) => option.id)).toEqual([
			"mode",
			"model",
			"fast",
			"thinking",
		]);

		await startNativeBackend(agent, session.sessionId);
		expect(backends[0]!.options.modelId).toBe("gpt-5.4-high-fast");
	});

	it("exposes fast config when only the base model variant is listed initially", async () => {
		const { agent } = createAgentTestHarness({
			models: [{ modelId: "composer-2.5", name: "Composer 2.5", current: true }],
		});

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);

		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
				default_model: "composer-2.5-fast",
			}),
		);

		expect(session.models?.currentModelId).toBe("composer-2.5-fast");
		expect(session.configOptions?.map((option) => option.id)).toEqual([
			"mode",
			"model",
			"fast",
		]);
		expect(session.configOptions?.find((option) => option.id === "fast")).toMatchObject({
			currentValue: "true",
		});
	});

	it("exposes a fast toggle and reasoning selector for parameterized SDK models", async () => {
		const { agent, client } = createAgentTestHarness({
			models: [
				{ modelId: "auto", name: "Auto", current: true },
				{
					modelId: "grok-4.6",
					name: "Cursor Grok 4.6",
					parameters: [
						{
							id: "effort",
							displayName: "Effort",
							values: [
								{ value: "low", displayName: "Low" },
								{ value: "high", displayName: "High" },
							],
						},
						{
							id: "fast",
							displayName: "Fast",
							values: [{ value: "false" }, { value: "true", displayName: "Fast" }],
						},
					],
					variants: [
						{
							params: [
								{ id: "effort", value: "high" },
								{ id: "fast", value: "true" },
							],
							isDefault: true,
						},
					],
				},
			],
		});
		await agent.initialize(
			initRequest({
				clientCapabilities: { session: { configOptions: { boolean: {} } } },
			}),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);
		expect(session.models?.currentModelId).toBe("auto");
		expect(session.configOptions?.map((option) => option.id)).toEqual(["mode", "model"]);

		client.updates.length = 0;
		const modelResponse = await agent.setSessionConfigOption({
			sessionId: session.sessionId,
			configId: "model",
			value: "grok-4.6",
		});
		const fast = modelResponse.configOptions.find((option) => option.id === "fast");
		const thinking = modelResponse.configOptions.find((option) => option.id === "thinking");

		expect(fast).toMatchObject({
			type: "boolean",
			category: "model_config",
			currentValue: true,
		});
		expect(thinking).toMatchObject({
			type: "select",
			name: "Effort",
			category: "thought_level",
			currentValue: "high",
		});
		const modelConfigUpdate = client.updates.find(
			(update) => update.update.sessionUpdate === "config_option_update",
		);
		expect(modelConfigUpdate?.update).toEqual({
			sessionUpdate: "config_option_update",
			configOptions: modelResponse.configOptions,
		});

		const thinkingResponse = await agent.setSessionConfigOption({
			sessionId: session.sessionId,
			configId: "thinking",
			value: "low",
		});
		expect(
			thinkingResponse.configOptions.find((option) => option.id === "thinking"),
		).toMatchObject({
			currentValue: "low",
		});

		const response = await agent.setSessionConfigOption({
			sessionId: session.sessionId,
			configId: "fast",
			type: "boolean",
			value: false,
		});
		expect(response.configOptions.find((option) => option.id === "fast")).toMatchObject({
			type: "boolean",
			currentValue: false,
		});
	});

	it("exposes boolean thinking and fast parameters as toggles and applies their values", async () => {
		const models: CursorModelDescriptor[] = [
			{
				modelId: "gpt-5.6-sol",
				name: "GPT-5.6 Sol",
				current: true,
				parameters: [
					{
						id: "reasoning",
						displayName: "Thinking",
						values: [
							{ value: "false", displayName: "Off" },
							{ value: "true", displayName: "On" },
						],
					},
					{
						id: "fast",
						values: [{ value: "false" }, { value: "true" }],
					},
				],
				variants: [
					{
						params: [
							{ id: "reasoning", value: "true" },
							{ id: "fast", value: "true" },
						],
						isDefault: true,
					},
				],
			},
		];
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-toggle-state-"));
		process.env.CURSOR_ACP_CONFIG_DIR = tempRoot;
		const { agent, client, legacyPromptCalls } = createAgentTestHarness({ models });
		await agent.initialize(
			initRequest({ clientCapabilities: { session: { configOptions: { boolean: {} } } } }),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp/toggle-project",
				default_config_options: { thinking: false, fast: false },
			}),
		);

		expect(session.configOptions?.find((option) => option.id === "thinking")).toMatchObject({
			type: "boolean",
			currentValue: false,
		});
		expect(session.configOptions?.find((option) => option.id === "fast")).toMatchObject({
			type: "boolean",
			currentValue: false,
		});

		client.updates.length = 0;
		const thinkingOnResponse = await agent.setSessionConfigOption({
			sessionId: session.sessionId,
			configId: "thinking",
			type: "boolean",
			value: true,
		});
		expect(
			thinkingOnResponse.configOptions.find((option) => option.id === "thinking"),
		).toMatchObject({ type: "boolean", currentValue: true });
		expect(client.updates[client.updates.length - 1]?.update).toEqual({
			sessionUpdate: "config_option_update",
			configOptions: thinkingOnResponse.configOptions,
		});
		const fastOnResponse = await agent.setSessionConfigOption({
			sessionId: session.sessionId,
			configId: "fast",
			type: "boolean",
			value: true,
		});
		expect(fastOnResponse.configOptions.find((option) => option.id === "fast")).toMatchObject({
			type: "boolean",
			currentValue: true,
		});
		expect(client.updates[client.updates.length - 1]?.update).toEqual({
			sessionUpdate: "config_option_update",
			configOptions: fastOnResponse.configOptions,
		});

		await agent.setSessionConfigOption({
			sessionId: session.sessionId,
			configId: "thinking",
			type: "boolean",
			value: false,
		});
		const fastOffResponse = await agent.setSessionConfigOption({
			sessionId: session.sessionId,
			configId: "fast",
			type: "boolean",
			value: false,
		});
		expect(client.updates[client.updates.length - 1]?.update).toEqual({
			sessionUpdate: "config_option_update",
			configOptions: fastOffResponse.configOptions,
		});

		await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "hello" }],
		});
		expect(legacyPromptCalls[0]).toMatchObject({
			thinkingLevel: "false",
			fastValue: "false",
		});

		const reloadedHarness = createAgentTestHarness({ models });
		await reloadedHarness.agent.initialize(
			initRequest({ clientCapabilities: { session: { configOptions: { boolean: {} } } } }),
		);
		const loaded = await reloadedHarness.agent.loadSession({
			sessionId: session.sessionId,
			cwd: "/tmp/toggle-project",
			mcpServers: [],
		});
		expect(loaded.configOptions?.find((option) => option.id === "thinking")).toMatchObject({
			type: "boolean",
			currentValue: false,
		});
		expect(loaded.configOptions?.find((option) => option.id === "fast")).toMatchObject({
			type: "boolean",
			currentValue: false,
		});

		delete process.env.CURSOR_ACP_CONFIG_DIR;
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("reapplies the current fast value after cancel while the old run still exits", async () => {
		const { agent, legacyPromptCalls, setLegacyPromptHandler } = createAgentTestHarness({
			models: [
				{ modelId: "auto", name: "Auto", current: true },
				{ modelId: "composer-2.5", name: "Composer 2.5" },
				{ modelId: "composer-2.5-fast", name: "Composer 2.5 Fast" },
			],
		});
		await agent.initialize(
			initRequest({ clientCapabilities: { session: { configOptions: { boolean: {} } } } }),
		);
		const session = await agent.newSession(
			newSessionRequest({ cwd: "/tmp/cancel-config-sync", default_model: "composer-2.5" }),
		);
		expect(session.configOptions?.find((option) => option.id === "fast")).toMatchObject({
			type: "boolean",
			currentValue: false,
		});

		let finishRun: (() => void) | undefined;
		setLegacyPromptHandler(async () => {
			if (legacyPromptCalls.length === 1) {
				await new Promise<void>((resolve) => {
					finishRun = resolve;
				});
			}
			return {
				events: [],
				resultEvent: { type: "result", subtype: "success", is_error: false },
				stderr: "",
				exitCode: 0,
			};
		});
		const primary = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "work" }],
		});
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		await agent.cancel({ sessionId: session.sessionId });
		expect(await primary).toEqual({ stopReason: "cancelled" });
		expect(getSessionState(agent, session.sessionId).activeRun).toBeDefined();
		await expect(
			agent.setSessionConfigOption({
				sessionId: session.sessionId,
				configId: "fast",
				value: "bogus",
			}),
		).rejects.toMatchObject({ code: -32602, data: "Invalid fast mode: bogus" });

		const response = await agent.setSessionConfigOption({
			sessionId: session.sessionId,
			configId: "fast",
			type: "boolean",
			value: false,
		});
		expect(response.configOptions.find((option) => option.id === "fast")).toMatchObject({
			currentValue: false,
		});

		const next = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "next turn" }],
		});
		expect(legacyPromptCalls).toHaveLength(1);
		finishRun?.();
		expect(await next).toEqual({ stopReason: "end_turn" });
		expect(legacyPromptCalls.map((call) => [call.promptText, call.fastValue])).toEqual([
			["work", "false"],
			["next turn", "false"],
		]);
	});

	it("applies a changed fast value after cancel once the old run exits", async () => {
		const { agent, legacyPromptCalls, setLegacyPromptHandler } = createAgentTestHarness({
			models: [
				{ modelId: "auto", name: "Auto", current: true },
				{ modelId: "composer-2.5", name: "Composer 2.5" },
				{ modelId: "composer-2.5-fast", name: "Composer 2.5 Fast" },
			],
		});
		await agent.initialize(
			initRequest({ clientCapabilities: { session: { configOptions: { boolean: {} } } } }),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp/cancel-config-sync",
				default_model: "composer-2.5-fast",
			}),
		);
		expect(session.configOptions?.find((option) => option.id === "fast")).toMatchObject({
			type: "boolean",
			currentValue: true,
		});

		let finishRun: (() => void) | undefined;
		setLegacyPromptHandler(async () => {
			if (legacyPromptCalls.length === 1) {
				await new Promise<void>((resolve) => {
					finishRun = resolve;
				});
			}
			return {
				events: [],
				resultEvent: { type: "result", subtype: "success", is_error: false },
				stderr: "",
				exitCode: 0,
			};
		});
		const primary = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "work" }],
		});
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		expect(legacyPromptCalls[0]?.fastValue).toBe("true");
		await agent.cancel({ sessionId: session.sessionId });
		expect(await primary).toEqual({ stopReason: "cancelled" });

		let synced = false;
		const sync = agent
			.setSessionConfigOption({
				sessionId: session.sessionId,
				configId: "fast",
				value: "false",
			})
			.then((result) => {
				synced = true;
				return result;
			});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(synced).toBe(false);

		finishRun?.();
		const response = await sync;
		expect(response.configOptions.find((option) => option.id === "fast")).toMatchObject({
			currentValue: false,
		});
		const next = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "next turn" }],
		});
		expect(await next).toEqual({ stopReason: "end_turn" });
		expect(
			legacyPromptCalls.map((call) => [call.promptText, call.modelId, call.fastValue]),
		).toEqual([
			["work", "composer-2.5-fast", "true"],
			["next turn", "composer-2.5", "false"],
		]);
	});

	it("applies a model change after cancel and still rejects one during a live run", async () => {
		const { agent, legacyPromptCalls, setLegacyPromptHandler } = createAgentTestHarness();
		await agent.initialize(initRequest());
		const session = await agent.newSession(
			newSessionRequest({ cwd: "/tmp/cancel-config-sync" }),
		);
		let finishRun: (() => void) | undefined;
		setLegacyPromptHandler(async () => {
			if (legacyPromptCalls.length === 1) {
				await new Promise<void>((resolve) => {
					finishRun = resolve;
				});
			}
			return {
				events: [],
				resultEvent: { type: "result", subtype: "success", is_error: false },
				stderr: "",
				exitCode: 0,
			};
		});
		const primary = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "work" }],
		});
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		await expect(
			agent.setSessionConfigOption({
				sessionId: session.sessionId,
				configId: "model",
				value: "gpt-5.2",
			}),
		).rejects.toMatchObject({
			code: -32602,
			data: "Cannot change model during an active prompt",
		});

		await agent.cancel({ sessionId: session.sessionId });
		expect(await primary).toEqual({ stopReason: "cancelled" });
		let synced = false;
		const sync = agent
			.setSessionConfigOption({
				sessionId: session.sessionId,
				configId: "model",
				value: "gpt-5.2",
			})
			.then((result) => {
				synced = true;
				return result;
			});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(synced).toBe(false);

		finishRun?.();
		const response = await sync;
		expect(response.configOptions.find((option) => option.id === "model")).toMatchObject({
			currentValue: "gpt-5.2",
		});
		const next = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "next turn" }],
		});
		expect(await next).toEqual({ stopReason: "end_turn" });
		expect(legacyPromptCalls.map((call) => [call.promptText, call.modelId])).toEqual([
			["work", legacyPromptCalls[0]?.modelId],
			["next turn", "gpt-5.2"],
		]);
	});

	it("applies a thinking change after cancel once the old run exits", async () => {
		const models: CursorModelDescriptor[] = [
			{
				modelId: "gpt-5.6-sol",
				name: "GPT-5.6 Sol",
				current: true,
				parameters: [
					{
						id: "reasoning",
						displayName: "Thinking",
						values: [
							{ value: "false", displayName: "Off" },
							{ value: "true", displayName: "On" },
						],
					},
				],
				variants: [{ params: [{ id: "reasoning", value: "true" }], isDefault: true }],
			},
		];
		const { agent, legacyPromptCalls, setLegacyPromptHandler } = createAgentTestHarness({
			models,
		});
		await agent.initialize(
			initRequest({ clientCapabilities: { session: { configOptions: { boolean: {} } } } }),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp/cancel-config-sync",
				default_config_options: { thinking: true },
			}),
		);
		expect(session.configOptions?.find((option) => option.id === "thinking")).toMatchObject({
			type: "boolean",
			currentValue: true,
		});

		let finishRun: (() => void) | undefined;
		setLegacyPromptHandler(async () => {
			if (legacyPromptCalls.length === 1) {
				await new Promise<void>((resolve) => {
					finishRun = resolve;
				});
			}
			return {
				events: [],
				resultEvent: { type: "result", subtype: "success", is_error: false },
				stderr: "",
				exitCode: 0,
			};
		});
		const primary = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "work" }],
		});
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		expect(legacyPromptCalls[0]?.thinkingLevel).toBe("true");
		await agent.cancel({ sessionId: session.sessionId });
		expect(await primary).toEqual({ stopReason: "cancelled" });

		const sync = agent.setSessionConfigOption({
			sessionId: session.sessionId,
			configId: "thinking",
			type: "boolean",
			value: false,
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		finishRun?.();
		const response = await sync;
		expect(response.configOptions.find((option) => option.id === "thinking")).toMatchObject({
			currentValue: false,
		});
		const next = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "next turn" }],
		});
		expect(await next).toEqual({ stopReason: "end_turn" });
		expect(legacyPromptCalls.map((call) => [call.promptText, call.thinkingLevel])).toEqual([
			["work", "true"],
			["next turn", "false"],
		]);
	});

	it("applies a legacy set_model request after cancel once the old run exits", async () => {
		const { agent, legacyPromptCalls, setLegacyPromptHandler } = createAgentTestHarness();
		await agent.initialize(initRequest());
		const session = await agent.newSession(
			newSessionRequest({ cwd: "/tmp/cancel-config-sync" }),
		);
		let finishRun: (() => void) | undefined;
		setLegacyPromptHandler(async () => {
			if (legacyPromptCalls.length === 1) {
				await new Promise<void>((resolve) => {
					finishRun = resolve;
				});
			}
			return {
				events: [],
				resultEvent: { type: "result", subtype: "success", is_error: false },
				stderr: "",
				exitCode: 0,
			};
		});
		const primary = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "work" }],
		});
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		await agent.cancel({ sessionId: session.sessionId });
		expect(await primary).toEqual({ stopReason: "cancelled" });

		const sync = agent.unstable_setSessionModel({
			sessionId: session.sessionId,
			modelId: "gpt-5.4-medium",
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		finishRun?.();
		await sync;
		const next = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "next turn" }],
		});
		expect(await next).toEqual({ stopReason: "end_turn" });
		expect(legacyPromptCalls.map((call) => [call.promptText, call.modelId])).toEqual([
			["work", legacyPromptCalls[0]?.modelId],
			["next turn", "gpt-5.4-medium"],
		]);
	});

	it("applies an in-flight config change before the next turn starts", async () => {
		const { agent, legacyPromptCalls, setLegacyPromptHandler } = createAgentTestHarness({
			models: [
				{ modelId: "auto", name: "Auto", current: true },
				{ modelId: "composer-2.5", name: "Composer 2.5" },
				{ modelId: "composer-2.5-fast", name: "Composer 2.5 Fast" },
			],
		});
		await agent.initialize(
			initRequest({ clientCapabilities: { session: { configOptions: { boolean: {} } } } }),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp/cancel-config-sync",
				default_model: "composer-2.5-fast",
			}),
		);
		let finishRun: (() => void) | undefined;
		const syncState = { settled: 0 };
		const runStarts = [] as boolean[];
		setLegacyPromptHandler(async () => {
			if (legacyPromptCalls.length === 2) {
				runStarts.push(syncState.settled === 2);
			}
			if (legacyPromptCalls.length === 1) {
				await new Promise<void>((resolve) => {
					finishRun = resolve;
				});
			}
			return {
				events: [],
				resultEvent: { type: "result", subtype: "success", is_error: false },
				stderr: "",
				exitCode: 0,
			};
		});
		const primary = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "work" }],
		});
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		await agent.cancel({ sessionId: session.sessionId });
		expect(await primary).toEqual({ stopReason: "cancelled" });

		const next = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "next turn" }],
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		const fastSync = agent
			.setSessionConfigOption({
				sessionId: session.sessionId,
				configId: "fast",
				value: "false",
			})
			.then((result) => {
				syncState.settled += 1;
				return result;
			});
		const modelSync = agent
			.setSessionConfigOption({
				sessionId: session.sessionId,
				configId: "model",
				value: "composer-2.5",
			})
			.then((result) => {
				syncState.settled += 1;
				return result;
			});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(legacyPromptCalls).toHaveLength(1);

		finishRun?.();
		await Promise.all([fastSync, modelSync]);
		expect(await next).toEqual({ stopReason: "end_turn" });
		expect(runStarts).toEqual([true]);
		expect(
			legacyPromptCalls.map((call) => [call.promptText, call.modelId, call.fastValue]),
		).toEqual([
			["work", "composer-2.5-fast", "true"],
			["next turn", "composer-2.5", "false"],
		]);
	});

	it("queues a second prompt that waited on the same config change", async () => {
		const { agent, legacyPromptCalls, setLegacyPromptHandler } = createAgentTestHarness({
			models: [
				{ modelId: "auto", name: "Auto", current: true },
				{ modelId: "composer-2.5", name: "Composer 2.5" },
				{ modelId: "composer-2.5-fast", name: "Composer 2.5 Fast" },
			],
		});
		await agent.initialize(
			initRequest({ clientCapabilities: { session: { configOptions: { boolean: {} } } } }),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp/cancel-config-sync",
				default_model: "composer-2.5-fast",
			}),
		);
		const finishRuns: Array<() => void> = [];
		setLegacyPromptHandler(
			async () =>
				await new Promise((resolve) => {
					finishRuns.push(() =>
						resolve({
							events: [],
							resultEvent: { type: "result", subtype: "success", is_error: false },
							stderr: "",
							exitCode: 0,
						}),
					);
				}),
		);
		const first = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "work" }],
		});
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		await agent.cancel({ sessionId: session.sessionId });
		expect(await first).toEqual({ stopReason: "cancelled" });

		const sync = agent.setSessionConfigOption({
			sessionId: session.sessionId,
			configId: "fast",
			value: "false",
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		const earlier = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "earlier" }],
		});
		const later = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "later" }],
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(legacyPromptCalls).toHaveLength(1);

		finishRuns[0]?.();
		await sync;
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(2));
		finishRuns[1]?.();
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(3));
		finishRuns[2]?.();
		expect(await Promise.all([earlier, later])).toEqual([
			{ stopReason: "end_turn" },
			{ stopReason: "end_turn" },
		]);
		expect(
			legacyPromptCalls.map((call) => [call.promptText, call.modelId, call.fastValue]),
		).toEqual([
			["work", "composer-2.5-fast", "true"],
			["earlier", "composer-2.5", "false"],
			["later", "composer-2.5", "false"],
		]);
	});

	it("falls back to selectors for boolean-shaped parameters on legacy clients", async () => {
		const { agent } = createAgentTestHarness({
			models: [
				{
					modelId: "gpt-5.6-sol",
					name: "GPT-5.6 Sol",
					current: true,
					parameters: [
						{ id: "thinking", values: [{ value: "false" }, { value: "true" }] },
						{ id: "fast", values: [{ value: "false" }, { value: "true" }] },
					],
				},
			],
		});
		await agent.initialize(initRequest({ clientCapabilities: {} }));
		const session = await agent.newSession(newSessionRequest());

		expect(session.configOptions?.find((option) => option.id === "thinking")).toMatchObject({
			type: "select",
			currentValue: "false",
		});
		expect(session.configOptions?.find((option) => option.id === "fast")).toMatchObject({
			type: "select",
			currentValue: "false",
		});
	});

	it("does not start native ACP when a config model changes before first prompt", async () => {
		const { agent, backends } = createAgentTestHarness({
			models: [
				{ modelId: "auto", name: "Auto" },
				{ modelId: "gpt-5.3-codex", name: "Codex 5.3", current: true },
				{ modelId: "composer-2.5", name: "Composer 2.5" },
				{ modelId: "composer-2.5-fast", name: "Composer 2.5 Fast" },
			],
		});

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
				default_model: "gpt-5.3-codex",
			}),
		);

		const response = await agent.setSessionConfigOption({
			sessionId: session.sessionId,
			configId: "model",
			value: "composer-2.5-fast",
		});

		expect(response.configOptions.find((option) => option.id === "model")).toMatchObject({
			currentValue: "composer-2.5-fast",
		});
		expect(response.configOptions.map((option) => option.id)).toEqual([
			"mode",
			"model",
			"fast",
		]);

		const internalSession = agentTestAccess(agent).sessions[session.sessionId]!;
		expect(internalSession.modelId).toBe("composer-2.5-fast");
		expect(backends).toHaveLength(0);
		expect(agentTestAccess(agent).buildConfigOptions(internalSession)).toEqual(
			response.configOptions,
		);
	});

	it("keeps all config options when mode changes before native warmup completes", async () => {
		let releaseNativeSession!: () => void;
		const createSessionBlocker = new Promise<void>((resolve) => {
			releaseNativeSession = resolve;
		});
		const { agent } = createAgentTestHarness({
			createSessionBlocker,
			models: [
				{ modelId: "auto", name: "Auto", current: true },
				{ modelId: "composer-2.5", name: "Composer 2.5" },
				{ modelId: "composer-2.5-fast", name: "Composer 2.5 Fast" },
			],
		});

		try {
			await agent.initialize(
				initRequest({
					protocolVersion: 1,
					clientCapabilities: {},
				}),
			);
			const session = await agent.newSession(
				newSessionRequest({
					cwd: "/tmp",
					mcpServers: [],
					default_model: "composer-2.5",
				}),
			);

			expect(session.configOptions?.map((option) => option.id)).toEqual([
				"mode",
				"model",
				"fast",
			]);

			const response = await agent.setSessionConfigOption({
				sessionId: session.sessionId,
				configId: "mode",
				value: "yolo",
			});

			expect(response.configOptions.map((option) => option.id)).toEqual([
				"mode",
				"model",
				"fast",
			]);
			expect(response.configOptions.find((option) => option.id === "mode")).toMatchObject({
				currentValue: "yolo",
			});
			expect(response.configOptions.find((option) => option.id === "model")).toMatchObject({
				currentValue: "composer-2.5",
			});
		} finally {
			releaseNativeSession();
		}
	});

	it("restores selected model config when loading a stored session", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-agent-load-config-"));
		process.env.CURSOR_ACP_CONFIG_DIR = tempRoot;

		try {
			const firstHarness = createAgentTestHarness({
				models: [
					{ modelId: "auto", name: "Auto", current: true },
					{ modelId: "gpt-5.4-medium", name: "GPT-5.4" },
					{ modelId: "gpt-5.2", name: "GPT-5.2" },
				],
			});

			await firstHarness.agent.initialize(
				initRequest({
					protocolVersion: 1,
					clientCapabilities: {},
				}),
			);
			const created = await firstHarness.agent.newSession(
				newSessionRequest({
					cwd: "/tmp/project",
					mcpServers: [],
				}),
			);

			await firstHarness.agent.setSessionConfigOption({
				sessionId: created.sessionId,
				configId: "model",
				value: "gpt-5.2",
			});

			const secondHarness = createAgentTestHarness({
				models: [
					{ modelId: "auto", name: "Auto", current: true },
					{ modelId: "gpt-5.4-medium", name: "GPT-5.4" },
					{ modelId: "gpt-5.2", name: "GPT-5.2" },
				],
			});

			await secondHarness.agent.initialize(
				initRequest({
					protocolVersion: 1,
					clientCapabilities: {},
				}),
			);
			const loaded = await secondHarness.agent.loadSession({
				sessionId: created.sessionId,
				cwd: "/tmp/project",
				mcpServers: [],
			});

			expect(loaded.models?.currentModelId).toBe("gpt-5.2");
			expect(loaded.configOptions?.find((option) => option.id === "model")).toMatchObject({
				currentValue: "gpt-5.2",
			});
		} finally {
			delete process.env.CURSOR_ACP_CONFIG_DIR;
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	it("uses default_mode from initialize _meta when newSession omits it", async () => {
		const { agent } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
				_meta: { default_mode: "yolo" },
			}),
		);

		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);

		expect(session.modes?.currentModeId).toBe("yolo");
	});

	it("uses default_config_options from initialize when newSession omits them", async () => {
		const { agent } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {
					_meta: {
						default_config_options: {
							mode: "yolo",
							model: "gpt-5.2",
						},
					},
				},
			}),
		);

		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);

		expect(session.modes?.currentModeId).toBe("yolo");
		expect(session.models?.currentModelId).toBe("gpt-5.2");
	});

	it("uses default_model from initialize clientCapabilities._meta when newSession omits it", async () => {
		const { agent, backends } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: { _meta: { default_model: "gpt-5.2" } },
			}),
		);

		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);

		expect(session.models?.currentModelId).toBe("gpt-5.2");

		await startNativeBackend(agent, session.sessionId);
		expect(backends[0]!.options.modelId).toBe("gpt-5.2");
	});

	it("uses environment variables as ultimate fallback for defaults", async () => {
		process.env.CURSOR_ACP_DEFAULT_MODE = "yolo";
		process.env.CURSOR_ACP_DEFAULT_MODEL = "gpt-5.4-medium";
		try {
			const { agent } = createAgentTestHarness();

			await agent.initialize(
				initRequest({
					protocolVersion: 1,
					clientCapabilities: {},
				}),
			);

			const session = await agent.newSession(
				newSessionRequest({
					cwd: "/tmp",
					mcpServers: [],
				}),
			);

			expect(session.modes?.currentModeId).toBe("yolo");
			expect(session.models?.currentModelId).toBe("gpt-5.4-medium");
		} finally {
			delete process.env.CURSOR_ACP_DEFAULT_MODE;
			delete process.env.CURSOR_ACP_DEFAULT_MODEL;
		}
	});

	it("newSession params override initialize defaults", async () => {
		const { agent } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
				_meta: { default_mode: "plan" },
			}),
		);

		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
				default_mode: "yolo",
			}),
		);

		expect(session.modes?.currentModeId).toBe("yolo");
	});

	it("advertises the ACP terminal auth method when supported", async () => {
		const agent = new CursorAcpAgent(new FakeClient());

		const response = await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: { auth: { terminal: true } },
			}),
		);

		expect(response.authMethods?.[0]).toMatchObject({
			type: "terminal",
			id: "cursor_sdk_login",
			args: ["login"],
		});
	});

	it("records /model before first prompt without starting native ACP", async () => {
		const { agent, backends } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);

		const recordSpy = vi.spyOn(agentTestAccess(agent), "restartBackend");

		const response = await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "/model gpt-5.4-medium" }],
		});

		expect(response.stopReason).toBe("end_turn");
		expect(backends).toHaveLength(0);
		expect(recordSpy).not.toHaveBeenCalled();
		expect(agentTestAccess(agent).sessions[session.sessionId]?.modelId).toBe("gpt-5.4-medium");

		recordSpy.mockRestore();
	});

	it("accepts /model fast variants before first prompt without starting native ACP", async () => {
		const { agent, backends } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);

		const restartSpy = vi.spyOn(agentTestAccess(agent), "restartBackend");

		const response = await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "/model gpt-5.4-medium-fast" }],
		});

		expect(response.stopReason).toBe("end_turn");
		expect(backends).toHaveLength(0);
		expect(restartSpy).not.toHaveBeenCalled();
		expect(agentTestAccess(agent).sessions[session.sessionId]?.modelId).toBe(
			"gpt-5.4-medium-fast",
		);

		restartSpy.mockRestore();
	});

	it("accepts legacy /model fast syntax before first prompt without starting native ACP", async () => {
		const { agent, backends } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);

		const restartSpy = vi.spyOn(agentTestAccess(agent), "restartBackend");

		const response = await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "/model gpt-5.4-medium[fast=true]" }],
		});

		expect(response.stopReason).toBe("end_turn");
		expect(backends).toHaveLength(0);
		expect(restartSpy).not.toHaveBeenCalled();
		expect(agentTestAccess(agent).sessions[session.sessionId]?.modelId).toBe(
			"gpt-5.4-medium-fast",
		);

		restartSpy.mockRestore();
	});

	it("forwards permission requests in default mode", async () => {
		const { agent, client, setLegacyPromptHandler } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);

		setLegacyPromptHandler(async (_promptText, options) => {
			await options.onEvent?.({
				type: "tool_call",
				subtype: "started",
				call_id: "t1",
				tool_call: {
					shellToolCall: {
						args: { command: "pwd" },
					},
				},
			});
			await options.onEvent?.({
				type: "tool_call",
				subtype: "completed",
				call_id: "t1",
				tool_call: {
					shellToolCall: {
						args: { command: "pwd" },
						result: { rejected: { command: "pwd", reason: "need approval" } },
					},
				},
			});
			return {
				events: [],
				resultEvent: { type: "result", subtype: "success", is_error: false },
				stderr: "",
				exitCode: 0,
			};
		});

		await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "run pwd" }],
		});

		expect(client.permissionCalls).toHaveLength(1);
		expect(client.permissionCalls[0]!.toolCall.title).toBe("pwd");
	});

	it("surfaces rejected stream-json tool calls to the client in auto-review mode", async () => {
		const { agent, client, setLegacyPromptHandler } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
				modeId: "auto-review",
			}),
		);

		setLegacyPromptHandler(async (_promptText, options) => {
			await options.onEvent?.({
				type: "tool_call",
				subtype: "completed",
				call_id: "t1",
				tool_call: {
					shellToolCall: {
						args: { command: "rm -rf /" },
						result: { rejected: { command: "rm -rf /", reason: "blocked" } },
					},
				},
			});
			return {
				events: [],
				resultEvent: { type: "result", subtype: "success", is_error: false },
				stderr: "",
				exitCode: 0,
			};
		});

		await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "delete everything" }],
		});

		expect(client.permissionCalls).toHaveLength(1);
		expect(client.permissionCalls[0]!.toolCall.title).toBe("rm -rf /");
	});

	it("does not turn a transport failure into an approval retry", async () => {
		const { agent, client, setLegacyPromptHandler } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);

		setLegacyPromptHandler(async (_promptText, options) => {
			await options.onEvent?.({
				type: "tool_call",
				subtype: "completed",
				call_id: "t1",
				tool_call: {
					shellToolCall: {
						args: { command: "pwd" },
						result: { rejected: { command: "pwd", reason: "blocked" } },
					},
				},
			});
			return {
				events: [],
				resultEvent: {
					type: "result",
					subtype: "transport_error",
					is_error: true,
					result: "Error: RetriableError: WritableIterable is closed",
				},
				stderr: "Error: RetriableError: WritableIterable is closed",
				exitCode: 1,
			};
		});

		await expect(
			agent.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "run pwd" }],
			}),
		).rejects.toThrow(/WritableIterable is closed/);
		expect(client.permissionCalls).toHaveLength(0);
	});

	it("auto-approves permission requests in yolo mode", async () => {
		const { agent, backends, client } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);
		await startNativeBackend(agent, session.sessionId);
		await agent.setSessionMode({
			sessionId: session.sessionId,
			modeId: "yolo",
		});

		backends[0]!.promptHandler = async () => {
			const response = await backends[0]!.callbacks.onRequestPermission({
				sessionId: backends[0]!.nativeSessionId!,
				options: [
					{
						optionId: "allow-always",
						kind: "allow_always",
						name: "Always allow",
					},
				],
				toolCall: {
					toolCallId: "t1",
					title: "`pwd`",
					rawInput: { command: "pwd" },
				},
			});
			expect(response.outcome.outcome).toBe("selected");
			expect(response).toMatchObject({
				outcome: {
					outcome: "selected",
					optionId: "allow-always",
				},
			});
			return { stopReason: "end_turn" };
		};

		await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "run pwd" }],
		});

		expect(client.permissionCalls).toHaveLength(0);
	});

	it("forwards permission requests in auto-review mode instead of auto-approving", async () => {
		const { agent, backends, client } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
				modeId: "auto-review",
			}),
		);

		await startNativeBackend(agent, session.sessionId);
		const response = await backends[0]!.callbacks.onRequestPermission({
			sessionId: backends[0]!.nativeSessionId!,
			options: [
				{
					optionId: "allow-always",
					kind: "allow_always",
					name: "Always allow",
				},
			],
			toolCall: {
				toolCallId: "t1",
				title: "`pwd`",
				rawInput: { command: "pwd" },
			},
		});

		expect(response).toMatchObject({
			outcome: {
				outcome: "selected",
				optionId: "allow-always",
			},
		});
		expect(client.permissionCalls).toHaveLength(1);
	});

	it("auto-approves edit-with-diff permission requests in yolo mode", async () => {
		const { agent, backends, client } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);
		await startNativeBackend(agent, session.sessionId);
		await agent.setSessionMode({
			sessionId: session.sessionId,
			modeId: "yolo",
		});

		backends[0]!.promptHandler = async () => {
			const response = await backends[0]!.callbacks.onRequestPermission({
				sessionId: backends[0]!.nativeSessionId!,
				options: [
					{
						optionId: "approved",
						kind: "allow_once",
						name: "Yes",
					},
					{
						optionId: "abort",
						kind: "reject_once",
						name: "No, provide feedback",
					},
				],
				toolCall: {
					toolCallId: "patch-1",
					kind: "edit",
					title: "Edit foo.ts",
					content: [
						{
							type: "diff",
							path: "/tmp/foo.ts",
							oldText: "a",
							newText: "b",
						},
					],
				},
			});
			expect(response).toMatchObject({
				outcome: { outcome: "selected", optionId: "approved" },
			});
			return { stopReason: "end_turn" };
		};

		await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "change foo" }],
		});

		expect(client.permissionCalls).toHaveLength(0);
	});

	it("maps wrapper plan mode to native plan mode and emits updates", async () => {
		const { agent, backends, client } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);
		await startNativeBackend(agent, session.sessionId);

		await agent.setSessionMode({
			sessionId: session.sessionId,
			modeId: "plan",
		});

		expect(backends[0]!.modeCalls).toContain("plan");
		expect(
			client.updates.some(
				(update) =>
					update.update?.sessionUpdate === "current_mode_update" &&
					update.update?.currentModeId === "plan",
			),
		).toBe(true);
	});

	it("normalizes native execute tool calls to text when terminal_output is unsupported", async () => {
		const { agent, backends, client } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);
		await startNativeBackend(agent, session.sessionId);

		await backends[0]!.callbacks.onSessionUpdate({
			sessionId: backends[0]!.nativeSessionId!,
			update: {
				sessionUpdate: "tool_call",
				toolCallId: "t1",
				kind: "execute",
				title: "Terminal",
				status: "in_progress",
				rawInput: {
					command: "pwd",
				},
				content: [{ type: "terminal", terminalId: "cursor-shell-t1" }],
				_meta: {
					terminal_info: {
						terminal_id: "cursor-shell-t1",
						cwd: "/tmp",
					},
				},
			},
		});

		await backends[0]!.callbacks.onSessionUpdate({
			sessionId: backends[0]!.nativeSessionId!,
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: "t1",
				kind: "execute",
				status: "completed",
				rawOutput: "/tmp\n",
				content: [{ type: "terminal", terminalId: "cursor-shell-t1" }],
				_meta: {
					terminal_output: {
						terminal_id: "cursor-shell-t1",
						data: "/tmp\n",
					},
					terminal_exit: {
						terminal_id: "cursor-shell-t1",
						exit_code: 0,
						signal: null,
					},
				},
			},
		});

		const started = client.updates.find(
			(u) => u.update.sessionUpdate === "tool_call" && u.update.toolCallId === "t1",
		);
		if (started?.update.sessionUpdate !== "tool_call") {
			throw new Error("Expected tool_call update");
		}
		expect(started.update.title).toBe("pwd");
		expect(
			started?.update.sessionUpdate === "tool_call"
				? started.update._meta?.terminal_info
				: undefined,
		).toBeUndefined();
		expect(
			started?.update.sessionUpdate === "tool_call" ? started.update.content : undefined,
		).toEqual([
			{
				type: "content",
				content: { type: "text", text: "```sh\npwd\n```\n\nCurrent directory:\n/tmp" },
			},
		]);

		const completed = client.updates.filter(
			(u) =>
				(u.update.sessionUpdate === "tool_call" ||
					u.update.sessionUpdate === "tool_call_update") &&
				u.update.toolCallId === "t1",
		)[1];
		expect(
			completed?.update.sessionUpdate === "tool_call_update"
				? completed.update._meta?.terminal_output
				: undefined,
		).toBeUndefined();
		expect(
			completed?.update.sessionUpdate === "tool_call_update"
				? completed.update._meta?.terminal_exit
				: undefined,
		).toBeUndefined();
		expect(
			completed?.update.sessionUpdate === "tool_call_update"
				? completed.update.content
				: undefined,
		).toEqual([
			{
				type: "content",
				content: { type: "text", text: "```\n/tmp\n```" },
			},
		]);
	});

	it("still normalizes shell-like terminal updates to text even when terminal_output is supported", async () => {
		const { agent, backends, client } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: { _meta: { terminal_output: true } },
			}),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);
		await startNativeBackend(agent, session.sessionId);

		await backends[0]!.callbacks.onSessionUpdate({
			sessionId: backends[0]!.nativeSessionId!,
			update: {
				sessionUpdate: "tool_call",
				toolCallId: "t2",
				kind: "execute",
				title: "Terminal",
				status: "in_progress",
				rawInput: {
					command: "pwd",
				},
				content: [{ type: "terminal", terminalId: "cursor-shell-t2" }],
				_meta: {
					terminal_info: {
						terminal_id: "cursor-shell-t2",
						cwd: "/tmp",
					},
				},
			},
		});

		const started = client.updates.find(
			(u) => u.update.sessionUpdate === "tool_call" && u.update.toolCallId === "t2",
		);
		expect(
			started?.update.sessionUpdate === "tool_call" ? started.update.content : undefined,
		).toEqual([
			{
				type: "content",
				content: { type: "text", text: "```sh\npwd\n```\n\nCurrent directory:\n/tmp" },
			},
		]);
		expect(started?.update?._meta?.terminal_info).toBeUndefined();
	});

	it("rejects a second prompt while one is in progress", async () => {
		const { agent, legacyPromptCalls, setLegacyPromptHandler } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);

		let resolvePrompt: (() => void) | undefined;
		setLegacyPromptHandler(
			async () =>
				await new Promise((resolve) => {
					resolvePrompt = () =>
						resolve({
							events: [],
							resultEvent: { type: "result", subtype: "success", is_error: false },
							stderr: "",
							exitCode: 0,
						});
				}),
		);

		const first = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "run something" }],
		});
		while (legacyPromptCalls.length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		await expect(
			agent.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "second" }],
			}),
		).rejects.toMatchObject({
			code: -32602,
			message: expect.stringContaining("already in flight"),
		});

		resolvePrompt?.();
		await first;
	});

	it("initialize advertises only the top-level midTurnSteering declaration", async () => {
		const capable = createAgentTestHarness({ supportsSteering: true });
		const response = await capable.agent.initialize(initRequest());
		expect(response._meta).toEqual({ midTurnSteering: true });
		expect(response.agentCapabilities).not.toHaveProperty("midTurnSteering");

		const unsupported = createAgentTestHarness();
		expect((await unsupported.agent.initialize(initRequest()))._meta).toBeUndefined();
	});

	it("idle primary prompt preserves SDK image input", async () => {
		const { agent, legacyPromptCalls } = createAgentTestHarness({ supportsSteering: true });
		await agent.initialize(initRequest());
		const session = await agent.newSession(newSessionRequest());
		await agent.prompt({
			sessionId: session.sessionId,
			prompt: [
				{ type: "text", text: "describe this" },
				{ type: "image", data: PNG_STEER_ATTACHMENT, mimeType: "image/png" },
			],
		});
		expect(legacyPromptCalls[0]?.promptText).toContain("describe this");
		expect(legacyPromptCalls[0]?.images).toEqual([
			{ data: PNG_STEER_ATTACHMENT, mimeType: "image/png" },
		]);
		expect(existsSync(steerSessionDir(session.sessionId))).toBe(false);
	});

	it("stacked steers are delivered in arrival order", async () => {
		const harness = createAgentTestHarness({ supportsSteering: true });
		const { agent, legacyPromptCalls, steerCalls, setLegacyPromptHandler, setSteerHandler } =
			harness;
		await agent.initialize(initRequest());
		const session = await agent.newSession(newSessionRequest());
		let finishRun: (() => void) | undefined;
		setLegacyPromptHandler(
			async () =>
				await new Promise((resolve) => {
					finishRun = () =>
						resolve({
							events: [],
							resultEvent: { type: "result", subtype: "success", is_error: false },
							stderr: "",
							exitCode: 0,
						});
				}),
		);
		let deliverFirst: (() => void) | undefined;
		setSteerHandler(async (text) => {
			if (text === "first steer") {
				await new Promise<void>((resolve) => {
					deliverFirst = resolve;
				});
			}
			return "complete_delivered";
		});
		const primary = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "work" }],
		});
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		const first = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "first steer" }],
		});
		const second = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "second steer" }],
		});
		await vi.waitFor(() => expect(steerCalls).toEqual(["first steer"]));
		deliverFirst?.();
		await vi.waitFor(() => expect(steerCalls).toEqual(["first steer", "second steer"]));
		finishRun?.();
		expect(await Promise.all([primary, first, second])).toEqual([
			{ stopReason: "end_turn" },
			{ stopReason: "end_turn" },
			{ stopReason: "end_turn" },
		]);
		expect(legacyPromptCalls).toHaveLength(1);
	});

	it("prompt arriving before the SDK run queues behind it", async () => {
		const { agent, legacyPromptCalls, steerCalls, setLegacyPromptHandler } =
			createAgentTestHarness({
				supportsSteering: true,
			});
		await agent.initialize(initRequest());
		const session = await agent.newSession(newSessionRequest());
		const finishRuns: Array<() => void> = [];
		setLegacyPromptHandler(
			async () =>
				await new Promise((resolve) => {
					finishRuns.push(() =>
						resolve({
							events: [],
							resultEvent: { type: "result", subtype: "success", is_error: false },
							stderr: "",
							exitCode: 0,
						}),
					);
				}),
		);
		const primary = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "work" }],
		});
		const steer = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "early steer" }],
		});
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		expect(steerCalls).toEqual([]);
		finishRuns[0]?.();
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(2));
		expect(legacyPromptCalls.map((call) => call.promptText)).toEqual(["work", "early steer"]);
		finishRuns[1]?.();
		expect(await Promise.all([primary, steer])).toEqual([
			{ stopReason: "end_turn" },
			{ stopReason: "end_turn" },
		]);
	});

	it("delivered steer settles with the shared run", async () => {
		const { agent, legacyPromptCalls, setLegacyPromptHandler } = createAgentTestHarness({
			supportsSteering: true,
		});
		await agent.initialize(initRequest());
		const session = await agent.newSession(newSessionRequest());
		let finishRun: (() => void) | undefined;
		setLegacyPromptHandler(
			async () =>
				await new Promise((resolve) => {
					finishRun = () =>
						resolve({
							events: [],
							resultEvent: { type: "result", subtype: "max_turns", is_error: false },
							stderr: "",
							exitCode: 0,
						});
				}),
		);
		const primary = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "work" }],
		});
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		let settled = false;
		const steer = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "adjust" }],
		});
		void steer.then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settled).toBe(false);
		finishRun?.();
		expect(await Promise.all([primary, steer])).toEqual([
			{ stopReason: "max_turn_requests" },
			{ stopReason: "max_turn_requests" },
		]);
	});

	it("steer does not cancel a pending permission request", async () => {
		const { agent, client, legacyPromptCalls, setLegacyPromptHandler } = createAgentTestHarness(
			{ supportsSteering: true },
		);
		await agent.initialize(initRequest());
		const session = await agent.newSession(newSessionRequest());
		let answerPermission: (() => void) | undefined;
		let permissionAnswered = false;
		vi.spyOn(client, "requestPermission").mockImplementation(async (request) => {
			client.permissionCalls.push(request);
			await new Promise<void>((resolve) => {
				answerPermission = resolve;
			});
			permissionAnswered = true;
			return { outcome: { outcome: "selected", optionId: "allow_once" } };
		});
		setLegacyPromptHandler(async (_text, { onEvent }) => {
			if (legacyPromptCalls.length === 1) {
				await onEvent?.({
					type: "tool_call",
					subtype: "completed",
					call_id: "approval-1",
					tool_call: {
						shellToolCall: {
							args: { command: "pwd" },
							result: { rejected: { command: "pwd", reason: "needs approval" } },
						},
					},
				});
			}
			return {
				events: [],
				resultEvent: { type: "result", subtype: "success", is_error: false },
				stderr: "",
				exitCode: 0,
			};
		});
		const primary = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "run pwd" }],
		});
		await vi.waitFor(() => expect(client.permissionCalls).toHaveLength(1));
		let steerSettled = false;
		const steer = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "also report cwd" }],
		});
		void steer.then(() => {
			steerSettled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(permissionAnswered).toBe(false);
		expect(steerSettled).toBe(false);
		expect(client.permissionCalls).toHaveLength(1);
		answerPermission?.();
		expect(
			(await Promise.all([primary, steer])).map((response) => response.stopReason),
		).toEqual(["end_turn", "end_turn"]);
		expect(permissionAnswered).toBe(true);
		expect(legacyPromptCalls.map((call) => call.promptText)).toEqual([
			"run pwd",
			"run pwd",
			"also report cwd",
		]);
	});

	it("permission retry replays delivered steers", async () => {
		const { agent, legacyPromptCalls, steerCalls, setLegacyPromptHandler } =
			createAgentTestHarness({ supportsSteering: true });
		await agent.initialize(initRequest());
		const session = await agent.newSession(newSessionRequest());
		let finishFirst: (() => void) | undefined;
		setLegacyPromptHandler(async (_text, { onEvent }) => {
			if (legacyPromptCalls.length === 1) {
				await new Promise<void>((resolve) => {
					finishFirst = resolve;
				});
				await onEvent?.({
					type: "tool_call",
					subtype: "completed",
					call_id: "approval-1",
					tool_call: {
						shellToolCall: {
							args: { command: "pwd" },
							result: { rejected: { command: "pwd", reason: "needs approval" } },
						},
					},
				});
			}
			return {
				events: [],
				resultEvent: { type: "result", subtype: "success", is_error: false },
				stderr: "",
				exitCode: 0,
			};
		});
		const primary = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "run pwd" }],
		});
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		const first = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "first adjustment" }],
		});
		const second = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "second adjustment" }],
		});
		await vi.waitFor(() =>
			expect(steerCalls).toEqual(["first adjustment", "second adjustment"]),
		);
		finishFirst?.();
		expect(
			(await Promise.all([primary, first, second])).map((response) => response.stopReason),
		).toEqual(Array(3).fill("end_turn"));
		expect(legacyPromptCalls.map((call) => [call.promptText, call.reviewPolicy])).toEqual([
			["run pwd", "auto-review"],
			["run pwd\n\nfirst adjustment\n\nsecond adjustment", "run-everything"],
		]);
	});

	it("cancel settles an unresolved steer delivery as cancelled", async () => {
		const { agent, legacyPromptCalls, steerCalls, setLegacyPromptHandler, setSteerHandler } =
			createAgentTestHarness({ supportsSteering: true });
		await agent.initialize(initRequest());
		const session = await agent.newSession(newSessionRequest());
		let finishRun: (() => void) | undefined;
		setLegacyPromptHandler(async () => {
			if (legacyPromptCalls.length === 1) {
				await new Promise<void>((resolve) => {
					finishRun = resolve;
				});
			}
			return {
				events: [],
				resultEvent: { type: "result", subtype: "success", is_error: false },
				stderr: "",
				exitCode: 0,
			};
		});
		let finishDelivery: (() => void) | undefined;
		setSteerHandler(
			async () =>
				await new Promise((resolve) => {
					finishDelivery = () => resolve("revert_to_followup");
				}),
		);
		const primary = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "work" }],
		});
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		const pending = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "pending" }],
		});
		await vi.waitFor(() => expect(steerCalls).toEqual(["pending"]));
		const deferred = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "deferred" }],
		});
		await agent.cancel({ sessionId: session.sessionId });
		expect(await Promise.all([primary, pending, deferred])).toEqual(
			Array(3).fill({ stopReason: "cancelled" }),
		);
		const next = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "next turn" }],
		});
		expect(legacyPromptCalls.map((call) => call.promptText)).toEqual(["work"]);
		finishDelivery?.();
		finishRun?.();
		expect(await next).toEqual({ stopReason: "end_turn" });
		expect(legacyPromptCalls.map((call) => call.promptText)).toEqual(["work", "next turn"]);
	});

	it("delivered steer is visible when the session resumes", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-steer-history-"));
		process.env.CURSOR_ACP_CONFIG_DIR = tempRoot;
		try {
			const {
				agent,
				legacyPromptCalls,
				steerCalls,
				setLegacyPromptHandler,
				setSteerHandler,
			} = createAgentTestHarness({ supportsSteering: true });
			await agent.initialize(initRequest());
			const session = await agent.newSession(
				newSessionRequest({ cwd: "/tmp/steer-project" }),
			);
			let finishRun: (() => void) | undefined;
			setLegacyPromptHandler(
				async (_text, { onEvent }) =>
					await new Promise((resolve) => {
						finishRun = () => {
							void (async () => {
								await onEvent?.({
									type: "assistant",
									message: { content: [{ type: "text", text: "done" }] },
								});
								resolve({
									events: [],
									resultEvent: {
										type: "result",
										subtype: "success",
										is_error: false,
									},
									stderr: "",
									exitCode: 0,
								});
							})();
						};
					}),
			);
			let deliverSteer: (() => void) | undefined;
			setSteerHandler(
				async () =>
					await new Promise((resolve) => {
						deliverSteer = () => resolve("complete_delivered");
					}),
			);
			const primary = agent.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "work" }],
			});
			await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
			const steer = agent.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "adjust" }],
			});
			await vi.waitFor(() => expect(steerCalls).toEqual(["adjust"]));
			let primarySettled = false;
			void primary.then(() => {
				primarySettled = true;
			});
			finishRun?.();
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(primarySettled).toBe(false);
			deliverSteer?.();
			await Promise.all([primary, steer]);
			setSteerHandler(async () => "revert_to_followup");
			const secondPrimary = agent.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "second work" }],
			});
			await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(2));
			const deferred = agent.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "later" }],
			});
			await vi.waitFor(() => expect(steerCalls).toEqual(["adjust", "later"]));
			finishRun?.();
			await secondPrimary;
			await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(3));
			finishRun?.();
			await deferred;

			const resumed = createAgentTestHarness({ supportsSteering: true });
			await resumed.agent.initialize(initRequest());
			await resumed.agent.unstable_resumeSession({
				sessionId: session.sessionId,
				cwd: "/tmp/steer-project",
				mcpServers: [],
			});
			await waitForScheduledUpdates();
			expect(
				resumed.client.updates.flatMap((update) => {
					const item = update.update;
					if (
						(item.sessionUpdate === "user_message_chunk" ||
							item.sessionUpdate === "agent_message_chunk") &&
						item.content.type === "text"
					) {
						return [`${item.sessionUpdate}:${item.content.text}`];
					}
					return [];
				}),
			).toEqual([
				"user_message_chunk:work",
				"user_message_chunk:adjust",
				"agent_message_chunk:done",
				"user_message_chunk:second work",
				"agent_message_chunk:done",
				"user_message_chunk:later",
				"agent_message_chunk:done",
			]);
		} finally {
			delete process.env.CURSOR_ACP_CONFIG_DIR;
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	it("reverted steer runs as a new run after the current one", async () => {
		const {
			agent,
			client,
			legacyPromptCalls,
			steerCalls,
			setLegacyPromptHandler,
			setSteerHandler,
		} = createAgentTestHarness({ supportsSteering: true });
		await agent.initialize(initRequest());
		const session = await agent.newSession(newSessionRequest());
		const finishRuns: Array<() => void> = [];
		setLegacyPromptHandler(
			async (text, { onEvent }) =>
				await new Promise((resolve) => {
					finishRuns.push(() => {
						void (async () => {
							await onEvent?.({
								type: "assistant",
								message: { content: [{ type: "text", text: `reply to ${text}` }] },
							});
							resolve({
								events: [],
								resultEvent: {
									type: "result",
									subtype: "success",
									is_error: false,
								},
								stderr: "",
								exitCode: 0,
							});
						})();
					});
				}),
		);
		setSteerHandler(async () => "revert_to_followup");
		const primary = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "work" }],
		});
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		let deferredSettled = false;
		const deferred = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "too late" }],
		});
		void deferred.then(() => {
			deferredSettled = true;
		});
		await vi.waitFor(() => expect(steerCalls).toEqual(["too late"]));
		expect(legacyPromptCalls).toHaveLength(1);
		expect(deferredSettled).toBe(false);
		finishRuns[0]?.();
		expect(await primary).toEqual({ stopReason: "end_turn" });
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(2));
		expect(legacyPromptCalls.map((call) => call.promptText)).toEqual(["work", "too late"]);
		expect(legacyPromptCalls[1]?.backendSessionId).toBe(legacyPromptCalls[0]?.backendSessionId);
		expect(deferredSettled).toBe(false);
		finishRuns[1]?.();
		expect(await deferred).toEqual({ stopReason: "end_turn" });
		expect(steerCalls).toEqual(["too late"]);
		expect(
			client.updates
				.filter((item) => item.update.sessionUpdate === "agent_message_chunk")
				.map((item) =>
					item.update.sessionUpdate === "agent_message_chunk" &&
					item.update.content.type === "text"
						? item.update.content.text
						: "",
				),
		).toEqual(["reply to work", "reply to too late"]);
	});

	it("prompts after a deferred input queue behind it", async () => {
		const { agent, legacyPromptCalls, steerCalls, setLegacyPromptHandler, setSteerHandler } =
			createAgentTestHarness({ supportsSteering: true });
		await agent.initialize(initRequest());
		const session = await agent.newSession(newSessionRequest());
		const finishRuns: Array<() => void> = [];
		setLegacyPromptHandler(
			async () =>
				await new Promise((resolve) => {
					finishRuns.push(() =>
						resolve({
							events: [],
							resultEvent: { type: "result", subtype: "success", is_error: false },
							stderr: "",
							exitCode: 0,
						}),
					);
				}),
		);
		setSteerHandler(async () => "revert_to_followup");
		const completed: string[] = [];
		const send = (text: string) => {
			const result = agent.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text }],
			});
			void result.then(() => completed.push(text));
			return result;
		};
		const primary = send("work");
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		const first = send("first deferred");
		await vi.waitFor(() => expect(steerCalls).toEqual(["first deferred"]));
		const second = send("second deferred");
		const third = send("third deferred");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(steerCalls).toEqual(["first deferred"]);
		finishRuns[0]?.();
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(2));
		expect(completed).toEqual(["work"]);
		finishRuns[1]?.();
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(3));
		expect(completed).toEqual(["work", "first deferred"]);
		finishRuns[2]?.();
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(4));
		expect(completed).toEqual(["work", "first deferred", "second deferred"]);
		finishRuns[3]?.();
		expect(await Promise.all([primary, first, second, third])).toEqual(
			Array(4).fill({ stopReason: "end_turn" }),
		);
		expect(legacyPromptCalls.map((call) => call.promptText)).toEqual([
			"work",
			"first deferred",
			"second deferred",
			"third deferred",
		]);
		expect(steerCalls).toEqual(["first deferred"]);
	});

	it("pending steer keeps arrival order when the run ends first", async () => {
		const { agent, legacyPromptCalls, steerCalls, setLegacyPromptHandler, setSteerHandler } =
			createAgentTestHarness({ supportsSteering: true });
		await agent.initialize(initRequest());
		const session = await agent.newSession(newSessionRequest());
		const finishRuns: Array<() => void> = [];
		setLegacyPromptHandler(
			async () =>
				await new Promise((resolve) => {
					finishRuns.push(() =>
						resolve({
							events: [],
							resultEvent: { type: "result", subtype: "success", is_error: false },
							stderr: "",
							exitCode: 0,
						}),
					);
				}),
		);
		let returnSteer: (() => void) | undefined;
		setSteerHandler(
			async () =>
				await new Promise((resolve) => {
					returnSteer = () => resolve("revert_to_followup");
				}),
		);
		const send = (text: string) =>
			agent.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text }],
			});
		const primary = send("work");
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		const earlier = send("earlier");
		await vi.waitFor(() => expect(steerCalls).toEqual(["earlier"]));
		finishRuns[0]?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const later = send("later");
		returnSteer?.();
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(2));
		expect(legacyPromptCalls.map((call) => call.promptText)).toEqual(["work", "earlier"]);
		finishRuns[1]?.();
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(3));
		expect(legacyPromptCalls.map((call) => call.promptText)).toEqual([
			"work",
			"earlier",
			"later",
		]);
		finishRuns[2]?.();
		expect(await Promise.all([primary, earlier, later])).toEqual(
			Array(3).fill({ stopReason: "end_turn" }),
		);
		expect(steerCalls).toEqual(["earlier"]);
	});

	it("failed run still drains a pending steer before its queued prompts", async () => {
		const { agent, legacyPromptCalls, steerCalls, setLegacyPromptHandler, setSteerHandler } =
			createAgentTestHarness({ supportsSteering: true });
		await agent.initialize(initRequest());
		const session = await agent.newSession(newSessionRequest());
		let failRun: (() => void) | undefined;
		setLegacyPromptHandler(async () => {
			if (legacyPromptCalls.length === 1) {
				await new Promise<void>((_resolve, reject) => {
					failRun = () => reject(new Error("transport failure"));
				});
			}
			return {
				events: [],
				resultEvent: { type: "result", subtype: "success", is_error: false },
				stderr: "",
				exitCode: 0,
			};
		});
		let returnSteer: (() => void) | undefined;
		setSteerHandler(
			async () =>
				await new Promise((resolve) => {
					returnSteer = () => resolve("revert_to_followup");
				}),
		);
		const send = (text: string) =>
			agent.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text }],
			});
		const primary = send("work");
		void primary.catch(() => undefined);
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		const earlier = send("earlier");
		await vi.waitFor(() => expect(steerCalls).toEqual(["earlier"]));
		failRun?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const later = send("later");
		returnSteer?.();
		await expect(primary).rejects.toThrow(/transport failure/);
		expect((await Promise.all([earlier, later])).map((item) => item.stopReason)).toEqual([
			"end_turn",
			"end_turn",
		]);
		expect(legacyPromptCalls.map((call) => call.promptText)).toEqual([
			"work",
			"earlier",
			"later",
		]);
		expect(steerCalls).toEqual(["earlier"]);
	});

	it("cancel settles pending and deferred prompts as cancelled", async () => {
		const { agent, legacyPromptCalls, steerCalls, setLegacyPromptHandler, setSteerHandler } =
			createAgentTestHarness({ supportsSteering: true });
		await agent.initialize(initRequest());
		const session = await agent.newSession(newSessionRequest());
		let finishRun: (() => void) | undefined;
		setLegacyPromptHandler(async () => {
			if (legacyPromptCalls.length === 1) {
				await new Promise<void>((resolve) => {
					finishRun = resolve;
				});
			}
			return {
				events: [],
				resultEvent: { type: "result", subtype: "success", is_error: false },
				stderr: "",
				exitCode: 0,
			};
		});
		setSteerHandler(async () => "revert_to_followup");
		const send = (text: string) =>
			agent.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text }],
			});
		const primary = send("work");
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		const deferred = agent.prompt({
			sessionId: session.sessionId,
			prompt: [
				{ type: "text", text: "deferred" },
				{ type: "image", data: PNG_STEER_ATTACHMENT, mimeType: "image/png" },
			],
		});
		await vi.waitFor(() => expect(steerCalls).toHaveLength(1));
		const filePath = /\[attachment: (.+?) \(MIME: image\/png\)/.exec(steerCalls[0]!)?.[1] ?? "";
		expect(existsSync(filePath)).toBe(true);
		const queued = send("queued");
		await agent.cancel({ sessionId: session.sessionId });
		expect(existsSync(filePath)).toBe(false);
		expect(existsSync(steerSessionDir(session.sessionId))).toBe(false);
		finishRun?.();
		expect(await Promise.all([primary, deferred, queued])).toEqual(
			Array(3).fill({ stopReason: "cancelled" }),
		);
		expect(legacyPromptCalls.map((call) => call.promptText)).toEqual(["work"]);
		expect(await send("next turn")).toEqual({ stopReason: "end_turn" });
		expect(legacyPromptCalls.map((call) => call.promptText)).toEqual(["work", "next turn"]);
	});

	it("slash prompt waits behind a deferred input", async () => {
		const { agent, legacyPromptCalls, steerCalls, setLegacyPromptHandler, setSteerHandler } =
			createAgentTestHarness({ supportsSteering: true });
		await agent.initialize(initRequest());
		const session = await agent.newSession(newSessionRequest());
		const finishRuns: Array<() => void> = [];
		setLegacyPromptHandler(
			async () =>
				await new Promise((resolve) => {
					finishRuns.push(() =>
						resolve({
							events: [],
							resultEvent: { type: "result", subtype: "success", is_error: false },
							stderr: "",
							exitCode: 0,
						}),
					);
				}),
		);
		let returnSteer: (() => void) | undefined;
		setSteerHandler(
			async () =>
				await new Promise((resolve) => {
					returnSteer = () => resolve("revert_to_followup");
				}),
		);
		const send = (text: string) =>
			agent.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text }],
			});
		const primary = send("work");
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		const deferred = send("deferred");
		await vi.waitFor(() => expect(steerCalls).toEqual(["deferred"]));
		let commandSettled = false;
		const command = send("/model gpt-5.2");
		void command.then(() => {
			commandSettled = true;
		});
		expect(commandSettled).toBe(false);
		finishRuns[0]?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		returnSteer?.();
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(2));
		expect(legacyPromptCalls[1]?.modelId).toBe(legacyPromptCalls[0]?.modelId);
		expect(commandSettled).toBe(false);
		finishRuns[1]?.();
		expect(
			(await Promise.all([primary, deferred, command])).map((item) => item.stopReason),
		).toEqual(["end_turn", "end_turn", "end_turn"]);
		const after = send("after command");
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(3));
		expect(legacyPromptCalls[2]?.modelId).toBe("gpt-5.2");
		finishRuns[2]?.();
		await after;
		expect(steerCalls).toEqual(["deferred"]);
	});

	it("steer paths never return the busy error", async () => {
		const { agent, steerCalls, legacyPromptCalls, setLegacyPromptHandler, setSteerHandler } =
			createAgentTestHarness({ supportsSteering: true });
		await agent.initialize(initRequest());
		const session = await agent.newSession(newSessionRequest());
		const finishRuns: Array<() => void> = [];
		setLegacyPromptHandler(
			async () =>
				await new Promise((resolve) => {
					finishRuns.push(() =>
						resolve({
							events: [],
							resultEvent: { type: "result", subtype: "success", is_error: false },
							stderr: "",
							exitCode: 0,
						}),
					);
				}),
		);
		setSteerHandler(async () => "revert_to_followup");
		const primary = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "work" }],
		});
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		const attachmentSteer = agent.prompt({
			sessionId: session.sessionId,
			prompt: [
				{ type: "image", data: PNG_STEER_ATTACHMENT, mimeType: "image/png" },
				{ type: "text", text: "with attachment" },
			],
		});
		await vi.waitFor(() => expect(steerCalls).toHaveLength(1));
		expect(steerCalls[0]).toContain("(MIME: image/png)");
		const returned = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "returned" }],
		});
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		const queued = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "queued" }],
		});
		finishRuns[0]?.();
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(2));
		finishRuns[1]?.();
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(3));
		finishRuns[2]?.();
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(4));
		finishRuns[3]?.();
		expect(await Promise.all([primary, attachmentSteer, returned, queued])).toEqual(
			Array(4).fill({ stopReason: "end_turn" }),
		);
		expect(legacyPromptCalls[1]?.promptText).toContain("(MIME: image/png)");
		expect(legacyPromptCalls[1]?.images).toBeUndefined();
	});

	it("non-text blocks in a steer become temp-file references in order", async () => {
		const { agent, steerCalls, legacyPromptCalls, setLegacyPromptHandler } =
			createAgentTestHarness({ supportsSteering: true });
		await agent.initialize(initRequest());
		const session = await agent.newSession(newSessionRequest());
		await rm(steerSessionDir(session.sessionId), { recursive: true, force: true });
		const finishRuns: Array<() => void> = [];
		setLegacyPromptHandler(
			async () =>
				await new Promise((resolve) => {
					finishRuns.push(() =>
						resolve({
							events: [],
							resultEvent: { type: "result", subtype: "success", is_error: false },
							stderr: "",
							exitCode: 0,
						}),
					);
				}),
		);
		const primary = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "work" }],
		});
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		const steer = agent.prompt({
			sessionId: session.sessionId,
			prompt: [
				{ type: "text", text: "check this screenshot" },
				{ type: "image", data: PNG_STEER_ATTACHMENT, mimeType: "image/png" },
				{
					type: "resource",
					resource: {
						uri: "file:///notes.md",
						text: "# release notes",
						mimeType: "text/markdown",
					},
				},
				{
					type: "resource_link",
					uri: "https://example.com/design-doc",
					name: "design-doc",
				},
				{ type: "text", text: "then summarize" },
			],
		});
		await vi.waitFor(() => expect(steerCalls).toHaveLength(1));
		const steerText = steerCalls[0]!;

		// Text blocks are kept verbatim; embedded resource content is written to
		// its file instead of being inlined; blocks appear in order.
		const positions = [
			steerText.indexOf("check this screenshot"),
			steerText.indexOf("https://example.com/design-doc"),
			steerText.indexOf("then summarize"),
		];
		expect(steerText).not.toContain("# release notes");
		expect(positions.every((index) => index >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);

		// Attachments are replaced by fixed-format reference lines, in order.
		const refs = [...steerText.matchAll(/\[attachment: (.+?) \(MIME: ([^)]+)\)/g)];
		expect(refs).toHaveLength(2);
		expect(refs.map((ref) => ref[2])).toEqual(["image/png", "text/markdown"]);
		for (const ref of refs) {
			expect(steerText.indexOf(ref[0]!)).toBeGreaterThan(positions[0]!);
		}
		expect(steerText.indexOf(refs[0]![0])).toBeLessThan(steerText.indexOf(refs[1]![0]));
		expect(steerText.indexOf("https://example.com/design-doc")).toBeGreaterThan(
			steerText.indexOf(refs[1]![0]),
		);
		expect(steerText).toContain("use the read-file tool to view it if needed");

		// Files are written with the MIME extension and only the current user
		// can read or write them.
		const firstPath = refs[0]![1]!;
		const secondPath = refs[1]![1]!;
		expect(firstPath.endsWith(".png")).toBe(true);
		expect(secondPath.endsWith(".md")).toBe(true);
		expect(existsSync(firstPath)).toBe(true);
		expect(existsSync(secondPath)).toBe(true);
		expect(await statMode(firstPath)).toBe(0o600);
		expect(await statMode(secondPath)).toBe(0o600);
		const dir = steerSessionDir(session.sessionId);
		expect(await statMode(dir)).toBe(0o700);
		expect(path.dirname(firstPath)).toBe(dir);
		expect(path.dirname(secondPath)).toBe(dir);

		finishRuns[0]?.();
		expect(await primary).toEqual({ stopReason: "end_turn" });
		await steer;
	});

	it("attachment files are cleaned up on session close", async () => {
		const { agent, steerCalls, legacyPromptCalls, setLegacyPromptHandler } =
			createAgentTestHarness({ supportsSteering: true });
		await agent.initialize(initRequest());
		const session = await agent.newSession(newSessionRequest());
		await rm(steerSessionDir(session.sessionId), { recursive: true, force: true });
		const finishRuns: Array<() => void> = [];
		setLegacyPromptHandler(
			async () =>
				await new Promise((resolve) => {
					finishRuns.push(() =>
						resolve({
							events: [],
							resultEvent: { type: "result", subtype: "success", is_error: false },
							stderr: "",
							exitCode: 0,
						}),
					);
				}),
		);
		const primary = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "work" }],
		});
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		const steer = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "image", data: PNG_STEER_ATTACHMENT, mimeType: "image/png" }],
		});
		await vi.waitFor(() => expect(steerCalls).toHaveLength(1));
		const filePath = /\[attachment: (.+?) \(MIME: image\/png\)/.exec(steerCalls[0]!)?.[1] ?? "";
		expect(filePath).not.toBe("");
		expect(existsSync(filePath)).toBe(true);

		finishRuns[0]?.();
		expect(await Promise.all([primary, steer])).toEqual([
			{ stopReason: "end_turn" },
			{ stopReason: "end_turn" },
		]);
		expect(existsSync(filePath)).toBe(true);

		await agent.closeSession({ sessionId: session.sessionId });

		expect(existsSync(filePath)).toBe(false);
		expect(existsSync(steerSessionDir(session.sessionId))).toBe(false);
	});

	it("cancel cleans up attachment files when nothing is pending", async () => {
		const { agent, steerCalls, legacyPromptCalls, setLegacyPromptHandler } =
			createAgentTestHarness({ supportsSteering: true });
		await agent.initialize(initRequest());
		const session = await agent.newSession(newSessionRequest());
		await rm(steerSessionDir(session.sessionId), { recursive: true, force: true });
		setLegacyPromptHandler(
			async () =>
				await new Promise(() => {
					// Never resolves: cancel must still clean up the attachments.
				}),
		);
		void agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "work" }],
		});
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		void agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "image", data: PNG_STEER_ATTACHMENT, mimeType: "image/png" }],
		});
		await vi.waitFor(() => expect(steerCalls).toHaveLength(1));
		const filePath = /\[attachment: (.+?) \(MIME: image\/png\)/.exec(steerCalls[0]!)?.[1] ?? "";
		expect(existsSync(filePath)).toBe(true);

		await agent.cancel({ sessionId: session.sessionId });

		expect(existsSync(filePath)).toBe(false);
		expect(existsSync(steerSessionDir(session.sessionId))).toBe(false);
	});

	it("deferred steer with attachments runs with the temp-file reference text", async () => {
		const { agent, steerCalls, legacyPromptCalls, setLegacyPromptHandler, setSteerHandler } =
			createAgentTestHarness({ supportsSteering: true });
		await agent.initialize(initRequest());
		const session = await agent.newSession(newSessionRequest());
		await rm(steerSessionDir(session.sessionId), { recursive: true, force: true });
		const finishRuns: Array<() => void> = [];
		let deferredRunSawAttachmentFile: boolean | undefined;
		setLegacyPromptHandler(
			async (text) =>
				await new Promise((resolve) => {
					if (legacyPromptCalls.length === 2) {
						const match = /\[attachment: (.+?) \(MIME: image\/png\)/.exec(text);
						deferredRunSawAttachmentFile = match ? existsSync(match[1]!) : false;
					}
					finishRuns.push(() =>
						resolve({
							events: [],
							resultEvent: { type: "result", subtype: "success", is_error: false },
							stderr: "",
							exitCode: 0,
						}),
					);
				}),
		);
		setSteerHandler(async () => "revert_to_followup");
		const primary = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "work" }],
		});
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		const steer = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "image", data: PNG_STEER_ATTACHMENT, mimeType: "image/png" }],
		});
		await vi.waitFor(() => expect(steerCalls).toHaveLength(1));
		finishRuns[0]?.();
		expect(await primary).toEqual({ stopReason: "end_turn" });

		// The deferred input runs as a new run with the exact steer text that was
		// handed to run.steer, and without raw image blocks.
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(2));
		expect(legacyPromptCalls[1]?.promptText).toBe(steerCalls[0]);
		expect(legacyPromptCalls[1]?.images).toBeUndefined();
		expect(deferredRunSawAttachmentFile).toBe(true);
		finishRuns[1]?.();
		await steer;
	});

	it("consecutive attachment steers queue with their converted text", async () => {
		const { agent, steerCalls, legacyPromptCalls, setLegacyPromptHandler, setSteerHandler } =
			createAgentTestHarness({ supportsSteering: true });
		await agent.initialize(initRequest());
		const session = await agent.newSession(newSessionRequest());
		await rm(steerSessionDir(session.sessionId), { recursive: true, force: true });
		const finishRuns: Array<() => void> = [];
		setLegacyPromptHandler(
			async () =>
				await new Promise((resolve) => {
					finishRuns.push(() =>
						resolve({
							events: [],
							resultEvent: { type: "result", subtype: "success", is_error: false },
							stderr: "",
							exitCode: 0,
						}),
					);
				}),
		);
		setSteerHandler(async () => "revert_to_followup");
		const primary = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "work" }],
		});
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		const firstSteer = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "image", data: PNG_STEER_ATTACHMENT, mimeType: "image/png" }],
		});
		await vi.waitFor(() => expect(steerCalls).toHaveLength(1));
		const secondSteer = agent.prompt({
			sessionId: session.sessionId,
			prompt: [
				{ type: "text", text: "second" },
				{ type: "image", data: PNG_STEER_ATTACHMENT, mimeType: "image/png" },
			],
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		// The second steer must not call run.steer while the first is deferred.
		expect(steerCalls).toHaveLength(1);
		finishRuns[0]?.();
		expect(await primary).toEqual({ stopReason: "end_turn" });
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(2));
		expect(legacyPromptCalls[1]?.promptText).toBe(steerCalls[0]);
		expect(legacyPromptCalls[1]?.images).toBeUndefined();
		finishRuns[1]?.();
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(3));
		// The second steer runs with the same converted text it would have been
		// injected with, and without raw image blocks.
		expect(legacyPromptCalls[2]?.promptText).toContain("second");
		expect(legacyPromptCalls[2]?.promptText).toContain("(MIME: image/png)");
		expect(legacyPromptCalls[2]?.images).toBeUndefined();
		const secondPath =
			/\[attachment: (.+?) \(MIME: image\/png\)/.exec(
				legacyPromptCalls[2]!.promptText,
			)?.[1] ?? "";
		expect(secondPath).not.toBe("");
		expect(existsSync(secondPath)).toBe(true);
		finishRuns[2]?.();
		expect(await Promise.all([firstSteer, secondSteer])).toEqual([
			{ stopReason: "end_turn" },
			{ stopReason: "end_turn" },
		]);
		expect(steerCalls).toHaveLength(1);
	});

	it("cancel during attachment writes still removes the files", async () => {
		const { agent, steerCalls, legacyPromptCalls, setLegacyPromptHandler, setSteerHandler } =
			createAgentTestHarness({ supportsSteering: true });
		await agent.initialize(initRequest());
		const session = await agent.newSession(newSessionRequest());
		await rm(steerSessionDir(session.sessionId), { recursive: true, force: true });
		const finishRuns: Array<() => void> = [];
		setLegacyPromptHandler(
			async () =>
				await new Promise((resolve) => {
					finishRuns.push(() =>
						resolve({
							events: [],
							resultEvent: { type: "result", subtype: "success", is_error: false },
							stderr: "",
							exitCode: 0,
						}),
					);
				}),
		);
		let releaseFirstSteer: (() => void) | undefined;
		setSteerHandler(async () => {
			if (steerCalls.length === 1) {
				return await new Promise((resolve) => {
					releaseFirstSteer = () => resolve("revert_to_followup");
				});
			}
			return "complete_delivered";
		});
		const primary = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "work" }],
		});
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(1));
		void agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "image", data: PNG_STEER_ATTACHMENT, mimeType: "image/png" }],
		});
		await vi.waitFor(() => expect(steerCalls).toHaveLength(1));
		// Many attachments keep the conversion in flight while cancel arrives.
		const manyImages = Array.from({ length: 150 }, () => ({
			type: "image" as const,
			data: PNG_STEER_ATTACHMENT,
			mimeType: "image/png",
		}));
		const secondSteer = agent.prompt({ sessionId: session.sessionId, prompt: manyImages });
		releaseFirstSteer?.();
		await new Promise((resolve) => setTimeout(resolve, 10));
		const cancelling = agent.cancel({ sessionId: session.sessionId });
		const next = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "next turn" }],
		});
		await cancelling;
		expect(existsSync(steerSessionDir(session.sessionId))).toBe(false);
		const oldSteerCallCount = steerCalls.length;
		finishRuns[0]?.();
		expect(await primary).toEqual({ stopReason: "cancelled" });
		expect(await secondSteer).toEqual({ stopReason: "cancelled" });
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(2));
		const nextSteer = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "image", data: PNG_STEER_ATTACHMENT, mimeType: "image/png" }],
		});
		await vi.waitFor(() => expect(steerCalls).toHaveLength(oldSteerCallCount + 1));
		const filePath =
			/\[attachment: (.+?) \(MIME: image\/png\)/.exec(
				steerCalls[steerCalls.length - 1]!,
			)?.[1] ?? "";
		expect(existsSync(filePath)).toBe(true);
		finishRuns[1]?.();
		expect((await Promise.all([next, nextSteer])).map((item) => item.stopReason)).toEqual([
			"end_turn",
			"end_turn",
		]);
		expect(existsSync(filePath)).toBe(true);
	});

	it("prompt during permission retry gap queues for a later run", async () => {
		const { agent, client, legacyPromptCalls, steerCalls, setLegacyPromptHandler } =
			createAgentTestHarness({ supportsSteering: true });
		await agent.initialize(initRequest());
		const session = await agent.newSession(newSessionRequest({ modeId: "auto-review" }));
		let allowPermission: (() => void) | undefined;
		client.requestPermission = async (params) => {
			client.permissionCalls.push(params);
			await new Promise<void>((resolve) => {
				allowPermission = resolve;
			});
			return { outcome: { outcome: "selected", optionId: "allow_once" } };
		};
		const finishRuns: Array<() => void> = [];
		setLegacyPromptHandler(async (_text, { onEvent }) => {
			if (legacyPromptCalls.length === 1) {
				await onEvent?.({
					type: "tool_call",
					subtype: "completed",
					call_id: "t1",
					tool_call: {
						shellToolCall: {
							args: { command: "pwd" },
							result: { rejected: { command: "pwd", reason: "blocked" } },
						},
					},
				});
				return {
					events: [],
					resultEvent: { type: "result", subtype: "success", is_error: false },
					stderr: "",
					exitCode: 0,
				};
			}
			return await new Promise((resolve) => {
				finishRuns.push(() =>
					resolve({
						events: [],
						resultEvent: { type: "result", subtype: "success", is_error: false },
						stderr: "",
						exitCode: 0,
					}),
				);
			});
		});
		const primary = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "work" }],
		});
		await vi.waitFor(() => expect(client.permissionCalls).toHaveLength(1));
		const gapPrompt = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "during approval" }],
		});
		expect(steerCalls).toEqual([]);
		allowPermission?.();
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(2));
		finishRuns[0]?.();
		await vi.waitFor(() => expect(legacyPromptCalls).toHaveLength(3));
		finishRuns[1]?.();
		expect(
			(await Promise.all([primary, gapPrompt])).map((response) => response.stopReason),
		).toEqual(["end_turn", "end_turn"]);
		expect(legacyPromptCalls.map((call) => call.promptText)).toEqual([
			"work",
			"work",
			"during approval",
		]);
	});

	it("rejects model changes while a prompt is active", async () => {
		const { agent, legacyPromptCalls, setLegacyPromptHandler } = createAgentTestHarness();

		await agent.initialize(
			initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		);
		const session = await agent.newSession(
			newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			}),
		);

		let resolvePrompt: (() => void) | undefined;
		setLegacyPromptHandler(
			async () =>
				await new Promise((resolve) => {
					resolvePrompt = () =>
						resolve({
							events: [],
							resultEvent: { type: "result", subtype: "success", is_error: false },
							stderr: "",
							exitCode: 0,
						});
				}),
		);

		const promptPromise = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "run something" }],
		});
		while (legacyPromptCalls.length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		await expect(
			agent.unstable_setSessionModel({
				sessionId: session.sessionId,
				modelId: "gpt-5.4-medium",
			}),
		).rejects.toThrow("Invalid params");

		resolvePrompt?.();
		await promptPromise;
	});

	it("replays stored history when resuming and creates a fresh native backend", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-agent-"));
		process.env.CURSOR_ACP_CONFIG_DIR = tempRoot;

		try {
			const { agent, backends, client } = createAgentTestHarness();

			await recordUserMessage("/tmp/project", "session-1", "hello");
			await recordAssistantMessage("/tmp/project", "session-1", "world");

			await agent.initialize(
				initRequest({
					protocolVersion: 1,
					clientCapabilities: {},
				}),
			);
			await agent.unstable_resumeSession({
				sessionId: "session-1",
				cwd: "/tmp/project",
				mcpServers: [],
			});
			await waitForScheduledUpdates();

			expect(backends).toHaveLength(0);
			expect(
				client.updates.filter((u) => u.update?.sessionUpdate === "user_message_chunk"),
			).toHaveLength(1);
			expect(
				client.updates.filter((u) => u.update?.sessionUpdate === "agent_message_chunk"),
			).toHaveLength(1);
		} finally {
			delete process.env.CURSOR_ACP_CONFIG_DIR;
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	it("preserves backendSessionId when resuming a session via loadSession", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-agent-"));
		process.env.CURSOR_ACP_CONFIG_DIR = tempRoot;

		try {
			await recordSessionMeta("/tmp/project", "session-load-test", {
				backendSessionId: "agent-persisted-sdk-1",
				modelId: "gpt-5.4-medium",
			});

			const { agent, legacyPromptCalls } = createAgentTestHarness();
			await agent.initialize(initRequest());
			await agent.loadSession({
				sessionId: "session-load-test",
				cwd: "/tmp/project",
				mcpServers: [],
			});

			await agent.prompt({
				sessionId: "session-load-test",
				prompt: [{ type: "text", text: "next question" }],
			});

			expect(legacyPromptCalls).toHaveLength(1);
			expect(legacyPromptCalls[0]!.backendSessionId).toBe("agent-persisted-sdk-1");
		} finally {
			delete process.env.CURSOR_ACP_CONFIG_DIR;
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	it("preserves backendSessionId when resuming a session via resumeSession", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-agent-"));
		process.env.CURSOR_ACP_CONFIG_DIR = tempRoot;

		try {
			await recordSessionMeta("/tmp/project", "session-resume-test", {
				backendSessionId: "agent-persisted-sdk-2",
				modelId: "gpt-5.4-medium",
			});

			const { agent, legacyPromptCalls } = createAgentTestHarness();
			await agent.initialize(initRequest());
			await (agent as unknown as { resumeSession: Function }).resumeSession({
				sessionId: "session-resume-test",
				cwd: "/tmp/project",
			});

			await agent.prompt({
				sessionId: "session-resume-test",
				prompt: [{ type: "text", text: "next question" }],
			});

			expect(legacyPromptCalls).toHaveLength(1);
			expect(legacyPromptCalls[0]!.backendSessionId).toBe("agent-persisted-sdk-2");
		} finally {
			delete process.env.CURSOR_ACP_CONFIG_DIR;
			await rm(tempRoot, { recursive: true, force: true });
		}
	});
});
