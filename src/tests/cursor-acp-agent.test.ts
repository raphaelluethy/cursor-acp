import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
	AvailableCommand,
	NewSessionResponse,
	PromptResponse,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionNotification,
} from "@agentclientprotocol/sdk";
import {
	CreateNativeSessionOptions,
	NativeModeId,
	NativeSessionBackend,
	NativeSessionCallbacks,
} from "../cursor-native-acp-client.js";
import { CursorAcpAgent } from "../cursor-acp-agent.js";
import type { CursorAcpClient } from "../cursor-acp-client.js";
import type { RunPromptOptions } from "../cursor-cli-runner.js";
import {
	recordAssistantMessage,
	recordSessionMeta,
	recordUserMessage,
} from "../session-storage.js";
import {
	agentTestAccess,
	awaitNativeWarmup,
	ensureNativeBackend,
	initRequest,
	newSessionRequest,
} from "./test-support.js";
import type { LegacyPromptHandler, TestCliRunner } from "./test-support.js";

class FakeClient implements CursorAcpClient {
	updates: SessionNotification[] = [];
	permissionCalls: RequestPermissionRequest[] = [];
	extMethodCalls: { method: string; params: Record<string, unknown> }[] = [];
	extNotificationCalls: { method: string; params: Record<string, unknown> }[] = [];
	extMethodResponses: Record<string, Record<string, unknown>> = {};

	async sessionUpdate(params: SessionNotification): Promise<void> {
		this.updates.push(params);
	}

	async requestPermission(
		params: RequestPermissionRequest,
	): Promise<RequestPermissionResponse> {
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
		} = {},
	) {
		this.nativeSessionId = `native-${index}`;
	}

	async cancel(): Promise<void> {}

	async close(): Promise<void> {
		this.alive = false;
		this.closeCalls += 1;
	}

	async createSessionBackend(): Promise<NewSessionResponse> {
		this.createCalls += 1;
		await this.backendOptions.createSessionBlocker;
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

	async loadSessionBackend(nativeSessionId: string): Promise<NewSessionResponse> {
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

	async restartBackend(): Promise<NewSessionResponse> {
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
	} = {},
) {
	const backends: FakeNativeBackend[] = [];
	const client = new FakeClient();
	let legacyPromptHandler: LegacyPromptHandler | undefined;
	const legacyPromptCalls: {
		promptText: string;
		backendSessionId?: string;
		force?: boolean;
	}[] = [];

	const runner: TestCliRunner = {
		async createChat() {
			return "legacy-chat-1";
		},
		async listModels() {
			return [
				{ modelId: "auto", name: "Auto", current: true },
				{ modelId: "gpt-5.4-medium", name: "GPT-5.4" },
				{ modelId: "gpt-5.4-medium-fast", name: "GPT-5.4 Fast" },
				{ modelId: "gpt-5.2", name: "GPT-5.2" },
				{ modelId: "claude-4.5-opus-high", name: "Opus 4.5" },
			];
		},
		startPrompt(options: RunPromptOptions) {
			legacyPromptCalls.push({
				promptText: options.prompt,
				backendSessionId: options.backendSessionId,
				force: options.force,
			});
			const completed = (async () => {
				if (legacyPromptHandler) {
					return await legacyPromptHandler(options.prompt, {
						backendSessionId: options.backendSessionId,
						force: options.force,
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
			};
		},
	};

	const agent = new CursorAcpAgent(client, {
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
	it("handles adapter slash commands without invoking native prompt", async () => {
		const { agent, client, legacyPromptCalls } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		}));
		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		}));

		const response = await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "/status" }],
		}));

		expect(response.stopReason).toBe("end_turn");
		expect(legacyPromptCalls).toHaveLength(0);
		expect(client.updates.some((u) => u.update?.sessionUpdate === "agent_message_chunk")).toBe(
			true,
		));
	});

	it("loads native slash commands during newSession when authenticated", async () => {
		const { agent, backends, client } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		}));
		await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		});
		await waitForScheduledUpdates();

		expect(backends).toHaveLength(1);
		const commandsUpdate = client.updates.find(
			(update) => update.update?.sessionUpdate === "available_commands_update",
		));
		const names = commandsUpdate?.update?.availableCommands?.map(
			(command: any) => command.name,
		);
		expect(names).toContain("commit");
		expect(names).toContain("help");
		expect(names).toContain("mode");
	});

	it("forwards colliding slash commands to the native backend", async () => {
		const { agent, legacyPromptCalls } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		}));
		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		}));
		await startNativeBackend(agent, session.sessionId);

		const response = await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "/mode plan" }],
		}));

		expect(response.stopReason).toBe("end_turn");
		expect(legacyPromptCalls.map((call) => call.promptText)).toEqual(["/mode plan"]);
		expect(agentTestAccess(agent).sessions[session.sessionId]?.modeId).toBe("default");
	});

	it("forwards native slash commands when advertised with a leading slash", async () => {
		const { agent, legacyPromptCalls } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		}));
		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		}));
		await startNativeBackend(agent, session.sessionId);

		agentTestAccess(agent).sessions[session.sessionId].nativeAvailableCommands = [
			{ name: "/mode", description: "Native mode", input: null },
		];

		const response = await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "/mode ask" }],
		}));

		expect(response.stopReason).toBe("end_turn");
		expect(legacyPromptCalls.map((call) => call.promptText)).toEqual(["/mode ask"]);
	});

	it("forwards native mcp slash commands across equivalent spellings", async () => {
		const { agent, legacyPromptCalls } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		}));
		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		}));
		await startNativeBackend(agent, session.sessionId);

		agentTestAccess(agent).sessions[session.sessionId].nativeAvailableCommands = [
			{ name: "mcp:github:issue", description: "MCP issue helper", input: null },
		];

		const response = await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "/mcp:github:issue 123" }],
		}));

		expect(response.stopReason).toBe("end_turn");
		expect(legacyPromptCalls.map((call) => call.promptText)).toEqual(["/mcp:github:issue 123"]);
	});

	it("merges native available commands with wrapper built-ins", async () => {
		const { agent, client } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		}));
		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		}));
		await startNativeBackend(agent, session.sessionId);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const commandsUpdate = client.updates.find(
			(update) => update.update?.sessionUpdate === "available_commands_update",
		));
		const names = commandsUpdate?.update?.availableCommands?.map(
			(command: any) => command.name,
		);
		expect(names).toContain("help");
		expect(names).toContain("mode");
		expect(names).toContain("commit");
		expect(names.filter((name: string) => name === "mode")).toHaveLength(1);
	});

	it("forwards native Cursor extension methods to the outer client with wrapper session id", async () => {
		const { agent, backends, client } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		}));
		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		}));
		await startNativeBackend(agent, session.sessionId);

		client.extMethodResponses["cursor/ask_question"] = { picked: "a" };
		const backend = backends[0]!;
		const result = await backend.simulateNativeExtMethod("cursor/ask_question", {
			sessionId: backend.nativeSessionId,
			questionId: "q1",
		}));

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
		}));
		expect(client.extNotificationCalls).toEqual([
			{
				method: "cursor/update_todos",
				params: { sessionId: session.sessionId, todos: [] },
			},
		]);
	});

	it("creates sessions before auth and defers native backend startup until first prompt", async () => {
		const { agent, backends } = createLoggedOutAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		});

		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		}));

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

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		});

		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		}));

		expect(session.models?.currentModelId).toBe("auto");
		expect(session.models?.availableModels.map((model) => model.modelId)).toEqual([
			"auto",
			"gpt-5.4-medium",
			"gpt-5.4-medium-fast",
			"gpt-5.2",
			"claude-4.5-opus-high",
		]);
	});

	it("returns newSession without waiting for native backend warm-up", async () => {
		let unblockWarmup!: () => void;
		const createSessionBlocker = new Promise<void>((resolve) => {
			unblockWarmup = resolve;
		});
		const { agent, backends } = createAgentTestHarness({ createSessionBlocker });

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		}));

		const newSessionPromise = agent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		});

		await new Promise((resolve) => setTimeout(resolve, 0));

		await expect(
			Promise.race([
				newSessionPromise.then((session) => session.models?.currentModelId),
				new Promise((resolve) => setTimeout(() => resolve("blocked"), 20)),
			]),
		).resolves.toBe("auto");
		expect(backends[0]!.createCalls).toBe(1);

		unblockWarmup();
		await newSessionPromise;
		await waitForScheduledUpdates();
	});

	it("prefers CLI model ids over native config-style model ids to avoid duplicates", async () => {
		const { agent } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		});

		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		});

		const internalSession = agentTestAccess(agent).sessions[session.sessionId];
		await (agent).applyNativeSessionModelsAndModes(internalSession, {
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
		}));

		expect(internalSession.nativeSessionModels.currentModelId).toBe("auto");
		expect(
			internalSession.nativeSessionModels.availableModels.map((model: any) => model.modelId),
		).toEqual([
			"auto",
			"gpt-5.4-medium",
			"gpt-5.4-medium-fast",
			"gpt-5.2",
			"claude-4.5-opus-high",
		]);
	});

	it("uses default mode by default", async () => {
		const { agent } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		});

		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		}));

		expect(session.modes?.currentModeId).toBe("default");
	});

	it("honors requested yolo mode when creating a new session", async () => {
		const { agent, backends, client } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		});

		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
			modeId: "yolo",
		}));

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
		}));

		expect(client.permissionCalls).toHaveLength(0);
	});

	it("accepts snake_case default_mode from ACP clients", async () => {
		const { agent, backends, client } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		});

		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
			default_mode: "yolo",
		}));

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
		}));

		expect(client.permissionCalls).toHaveLength(0);
	});

	it("accepts snake_case default_model from ACP clients", async () => {
		const { agent, backends } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		});

		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
			default_model: "gpt-5.2",
		}));

		expect(session.models?.currentModelId).toBe("gpt-5.2");

		await startNativeBackend(agent, session.sessionId);
		expect(backends[0]!.options.modelId).toBe("gpt-5.2");
	});

	it("normalizes legacy default_model syntax from ACP clients", async () => {
		const { agent, backends } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		});

		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
			default_model: "gpt-5.4-medium[fast=true]",
		}));

		expect(session.models?.currentModelId).toBe("gpt-5.4-medium-fast");

		await startNativeBackend(agent, session.sessionId);
		expect(backends[0]!.options.modelId).toBe("gpt-5.4-medium-fast");
	});

	it("accepts default_config_options mode and model from ACP clients", async () => {
		const { agent } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		});

		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
			default_config_options: {
				mode: "yolo",
				model: "gpt-5.2",
			},
		}));

		expect(session.modes?.currentModeId).toBe("yolo");
		expect(session.models?.currentModelId).toBe("gpt-5.2");
		expect(session.configOptions?.find((option) => option.id === "mode")?.currentValue).toBe(
			"yolo",
		));
		expect(session.configOptions?.find((option) => option.id === "model")?.currentValue).toBe(
			"gpt-5.2",
		);
	});

	it("uses default_mode from initialize _meta when newSession omits it", async () => {
		const { agent } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
			_meta: { default_mode: "yolo" },
		});

		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		}));

		expect(session.modes?.currentModeId).toBe("yolo");
	});

	it("uses default_config_options from initialize when newSession omits them", async () => {
		const { agent } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {
				_meta: {
					default_config_options: {
						mode: "yolo",
						model: "gpt-5.2",
					},
				},
			},
		});

		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		}));

		expect(session.modes?.currentModeId).toBe("yolo");
		expect(session.models?.currentModelId).toBe("gpt-5.2");
	});

	it("uses default_model from initialize clientCapabilities._meta when newSession omits it", async () => {
		const { agent, backends } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: { _meta: { default_model: "gpt-5.2" } },
		});

		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		}));

		expect(session.models?.currentModelId).toBe("gpt-5.2");

		await startNativeBackend(agent, session.sessionId);
		expect(backends[0]!.options.modelId).toBe("gpt-5.2");
	});

	it("keeps configured default model when native session reports auto", async () => {
		const { agent, backends } = createAgentTestHarness({ createCurrentModelId: "auto" });

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: { _meta: { default_model: "gpt-5.2" } },
		});

		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		}));

		expect(backends[0]!.options.modelId).toBe("gpt-5.2");
		expect(session.models?.currentModelId).toBe("gpt-5.2");
		expect(session.configOptions?.find((option) => option.id === "model")?.currentValue).toBe(
			"gpt-5.2",
		));
	});

	it("keeps configured plan mode when native session initially reports agent", async () => {
		const { agent, backends } = createAgentTestHarness({ createCurrentModeId: "agent" });

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
			_meta: { default_mode: "plan" },
		});

		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		}));

		expect(session.modes?.currentModeId).toBe("plan");
		expect(session.configOptions?.find((option) => option.id === "mode")?.currentValue).toBe(
			"plan",
		));
		await awaitNativeWarmup(agent, session.sessionId);
		expect(backends[0]!.modeCalls).toEqual(["plan"]);
	});

	it("uses environment variables as ultimate fallback for defaults", async () => {
		process.env.CURSOR_ACP_DEFAULT_MODE = "yolo";
		process.env.CURSOR_ACP_DEFAULT_MODEL = "gpt-5.4-medium";
		try {
			const { agent } = createAgentTestHarness();

			await agent.initialize(initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			});

			const session = await agent.newSession(newSessionRequest({
				cwd: "/tmp",
				mcpServers: [],
			});

			expect(session.modes?.currentModeId).toBe("yolo");
			expect(session.models?.currentModelId).toBe("gpt-5.4-medium");
		} finally {
			delete process.env.CURSOR_ACP_DEFAULT_MODE;
			delete process.env.CURSOR_ACP_DEFAULT_MODEL;
		}
	});

	it("newSession params override initialize defaults", async () => {
		const { agent } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
			_meta: { default_mode: "plan" },
		});

		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
			default_mode: "yolo",
		}));

		expect(session.modes?.currentModeId).toBe("yolo");
	});

	it("applies mode changes to the warmed native backend before first prompt", async () => {
		const { agent, backends } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		}));
		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		});

		await agent.setSessionMode({
			sessionId: session.sessionId,
			modeId: "plan",
		}));

		expect(backends).toHaveLength(1);
		await awaitNativeWarmup(agent, session.sessionId);
		expect(backends[0]!.modeCalls).toEqual(["plan"]);
	});

	it("reports terminal auth metadata using the configured native command", async () => {
		const agent = new CursorAcpAgent(new FakeClient(), {
			nativeCommand: "cursor-agent",
		});

		const response = await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: { _meta: { "terminal-auth": true } },
		}));

		expect(response.authMethods?.[0]?._meta?.["terminal-auth"]).toMatchObject({
			command: "cursor-agent",
			args: ["login"],
		});
	});

	it("restarts the warmed backend when /model runs before first prompt", async () => {
		const { agent, backends } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		}));
		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		});

		const recordSpy = vi.spyOn(agentTestAccess(agent), "restartBackend");

		const response = await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "/model gpt-5.4-medium" }],
		}));

		expect(response.stopReason).toBe("end_turn");
		expect(backends).toHaveLength(2);
		expect(recordSpy).toHaveBeenCalledOnce();
		expect(backends[1]!.options.modelId).toBe("gpt-5.4-medium");

		recordSpy.mockRestore();
	});

	it("accepts /model fast variants before first prompt and restarts the warmed backend", async () => {
		const { agent, backends } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		}));
		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		});

		const restartSpy = vi.spyOn(agentTestAccess(agent), "restartBackend");

		const response = await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "/model gpt-5.4-medium-fast" }],
		}));

		expect(response.stopReason).toBe("end_turn");
		expect(backends).toHaveLength(2);
		expect(restartSpy).toHaveBeenCalledOnce();
		expect(backends[1]!.options.modelId).toBe("gpt-5.4-medium-fast");
		expect(agentTestAccess(agent).sessions[session.sessionId]?.modelId).toBe("gpt-5.4-medium-fast");

		restartSpy.mockRestore();
	});

	it("accepts legacy /model fast syntax before first prompt and restarts the warmed backend", async () => {
		const { agent, backends } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		}));
		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		});

		const restartSpy = vi.spyOn(agentTestAccess(agent), "restartBackend");

		const response = await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "/model gpt-5.4-medium[fast=true]" }],
		}));

		expect(response.stopReason).toBe("end_turn");
		expect(backends).toHaveLength(2);
		expect(restartSpy).toHaveBeenCalledOnce();
		expect(backends[1]!.options.modelId).toBe("gpt-5.4-medium-fast");
		expect(agentTestAccess(agent).sessions[session.sessionId]?.modelId).toBe("gpt-5.4-medium-fast");

		restartSpy.mockRestore();
	});

	it("forwards permission requests in default mode", async () => {
		const { agent, client, setLegacyPromptHandler } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		}));
		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		});

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
		}));

		await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "run pwd" }],
		}));

		expect(client.permissionCalls).toHaveLength(1);
	});

	it("auto-approves permission requests in yolo mode", async () => {
		const { agent, backends, client } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		}));
		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		}));
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
		}));

		expect(client.permissionCalls).toHaveLength(0);
	});

	it("auto-approves edit-with-diff permission requests in yolo mode", async () => {
		const { agent, backends, client } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		}));
		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		}));
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
		}));

		expect(client.permissionCalls).toHaveLength(0);
	});

	it("maps wrapper plan mode to native plan mode and emits updates", async () => {
		const { agent, backends, client } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		}));
		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		}));
		await startNativeBackend(agent, session.sessionId);

		await agent.setSessionMode({
			sessionId: session.sessionId,
			modeId: "plan",
		}));

		expect(backends[0]!.modeCalls).toContain("plan");
		expect(
			client.updates.some(
				(update) =>
					update.update?.sessionUpdate === "current_mode_update" &&
					update.update?.currentModeId === "plan",
			),
		).toBe(true);
	});

	it("restarts the native backend when the model changes while idle", async () => {
		const { agent, backends } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		}));
		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		}));
		await startNativeBackend(agent, session.sessionId);

		await agent.unstable_setSessionModel({
			sessionId: session.sessionId,
			modelId: "gpt-5.4-medium",
		}));

		expect(backends).toHaveLength(2);
		expect(backends[0]!.closeCalls).toBe(1);
		expect(backends[1]!.options.modelId).toBe("gpt-5.4-medium");
	});

	it("passes fast model ids through to native backend restart", async () => {
		const { agent, backends } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		}));
		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		}));
		await startNativeBackend(agent, session.sessionId);

		await agent.unstable_setSessionModel({
			sessionId: session.sessionId,
			modelId: "gpt-5.4-medium-fast",
		}));

		expect(backends).toHaveLength(2);
		expect(backends[0]!.closeCalls).toBe(1);
		expect(backends[1]!.options.modelId).toBe("gpt-5.4-medium-fast");
	});

	it("normalizes legacy fast model ids before native backend restart", async () => {
		const { agent, backends } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		}));
		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		}));
		await startNativeBackend(agent, session.sessionId);

		await agent.unstable_setSessionModel({
			sessionId: session.sessionId,
			modelId: "gpt-5.4-medium[fast=true]",
		}));

		expect(backends).toHaveLength(2);
		expect(backends[0]!.closeCalls).toBe(1);
		expect(backends[1]!.options.modelId).toBe("gpt-5.4-medium-fast");
	});

	it("normalizes native execute tool calls to text when terminal_output is unsupported", async () => {
		const { agent, backends, client } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		}));
		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		}));
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

		const started = client.updates.find((u) => u.update?.toolCallId === "t1");
		expect(started?.update?.title).toBe("`pwd`");
		expect(started?.update?._meta?.terminal_info).toBeUndefined();
		expect(started?.update?.content).toEqual([
			{
				type: "content",
				content: { type: "text", text: "```sh\npwd\n```\n\nCurrent directory:\n/tmp" },
			},
		]);

		const completed = client.updates.filter((u) => u.update?.toolCallId === "t1")[1];
		expect(completed?.update?._meta?.terminal_output).toBeUndefined();
		expect(completed?.update?._meta?.terminal_exit).toBeUndefined();
		expect(completed?.update?.content).toEqual([
			{
				type: "content",
				content: { type: "text", text: "```\n/tmp\n```" },
			},
		]);
	});

	it("still normalizes shell-like terminal updates to text even when terminal_output is supported", async () => {
		const { agent, backends, client } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: { _meta: { terminal_output: true } },
		}));
		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		}));
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

		const started = client.updates.find((u) => u.update?.toolCallId === "t2");
		expect(started?.update?.content).toEqual([
			{
				type: "content",
				content: { type: "text", text: "```sh\npwd\n```\n\nCurrent directory:\n/tmp" },
			},
		]);
		expect(started?.update?._meta?.terminal_info).toBeUndefined();
	});

	it("rejects a second prompt while one is in progress", async () => {
		const { agent, legacyPromptCalls, setLegacyPromptHandler } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		}));
		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		});

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
		));

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
		).rejects.toThrow(/another prompt is in progress/);

		resolvePrompt?.();
		await first;
	});

	it("rejects model changes while a prompt is active", async () => {
		const { agent, legacyPromptCalls, setLegacyPromptHandler } = createAgentTestHarness();

		await agent.initialize(initRequest({
			protocolVersion: 1,
			clientCapabilities: {},
		}));
		const session = await agent.newSession(newSessionRequest({
			cwd: "/tmp",
			mcpServers: [],
		});

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
		));

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

			await agent.initialize(initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			});
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

	it("replays stored history after native session/load when a backend session id is stored", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-agent-"));
		process.env.CURSOR_ACP_CONFIG_DIR = tempRoot;

		try {
			const { agent, backends, client } = createAgentTestHarness();

			await recordUserMessage("/tmp/project", "session-1", "hello");
			await recordAssistantMessage("/tmp/project", "session-1", "world");
			await recordSessionMeta("/tmp/project", "session-1", {
				backendSessionId: "be-native-1",
				modeId: "yolo",
			}));

			await agent.initialize(initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			});
			const response = await agent.unstable_resumeSession({
				sessionId: "session-1",
				cwd: "/tmp/project",
				mcpServers: [],
			});
			await waitForScheduledUpdates();

			expect(backends).toHaveLength(1);
			expect(backends[0]!.loadCalls).toEqual(["be-native-1"]);
			expect(backends[0]!.createCalls).toBe(0);
			expect(response.modes?.currentModeId).toBe("yolo");
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

	it("replays stored history for stable loadSession after native session/load", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-agent-"));
		process.env.CURSOR_ACP_CONFIG_DIR = tempRoot;

		try {
			const { agent, backends, client } = createAgentTestHarness();

			await recordUserMessage("/tmp/project", "session-1", "hello");
			await recordAssistantMessage("/tmp/project", "session-1", "world");
			await recordSessionMeta("/tmp/project", "session-1", {
				backendSessionId: "be-native-1",
				modeId: "yolo",
			}));

			await agent.initialize(initRequest({
				protocolVersion: 1,
				clientCapabilities: {},
			});
			const response = await agent.loadSession({
				sessionId: "session-1",
				cwd: "/tmp/project",
				mcpServers: [],
			});
			await waitForScheduledUpdates();

			expect(backends).toHaveLength(1);
			expect(backends[0]!.loadCalls).toEqual(["be-native-1"]);
			expect(response.modes?.currentModeId).toBe("yolo");
			expect(response.models?.currentModelId).toBe("gpt-5.4-medium");
			expect(response.models?.availableModels.map((model) => model.modelId)).toEqual([
				"auto",
				"gpt-5.4-medium",
				"gpt-5.4-medium-fast",
				"gpt-5.2",
				"claude-4.5-opus-high",
			]);
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
});
