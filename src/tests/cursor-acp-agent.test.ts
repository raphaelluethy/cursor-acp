import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	CreateNativeSessionOptions,
	NativeModeId,
	NativeSessionBackend,
	NativeSessionCallbacks,
} from "../cursor-native-acp-client.js";
import { CursorAcpAgent } from "../cursor-acp-agent.js";
import {
	recordAssistantMessage,
	recordSessionMeta,
	recordUserMessage,
} from "../session-storage.js";

class FakeClient {
	updates: any[] = [];
	permissionCalls: any[] = [];
	extMethodCalls: { method: string; params: Record<string, unknown> }[] = [];
	extNotificationCalls: { method: string; params: Record<string, unknown> }[] = [];
	extMethodResponses: Record<string, Record<string, unknown>> = {};

	async sessionUpdate(params: any): Promise<void> {
		this.updates.push(params);
	}

	async requestPermission(params: any): Promise<any> {
		this.permissionCalls.push(params);
		const allowOption = params.options.find((option: any) => option.kind.startsWith("allow"));
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

	async readTextFile(_params: any): Promise<any> {
		return { content: "" };
	}

	async writeTextFile(_params: any): Promise<any> {
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
	promptHandler?: (promptText: string) => Promise<any>;

	constructor(
		readonly options: CreateNativeSessionOptions,
		readonly callbacks: NativeSessionCallbacks,
		private readonly index: number,
	) {
		this.nativeSessionId = `native-${index}`;
	}

	async cancel(): Promise<void> {}

	async close(): Promise<void> {
		this.alive = false;
		this.closeCalls += 1;
	}

	async createSessionBackend(): Promise<any> {
		this.createCalls += 1;
		await this.callbacks.onSessionUpdate({
			sessionId: this.nativeSessionId!,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands: [
					{ name: "commit", description: "Commit helper", input: null },
					{ name: "mode", description: "Native mode", input: null },
				],
			},
		} as any);

		return {
			sessionId: this.nativeSessionId!,
			models: {
				currentModelId: "auto",
				availableModels: [{ modelId: "auto", name: "Auto", description: "Auto" }],
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

	async loadSessionBackend(nativeSessionId: string): Promise<any> {
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
		} as any);

		return {
			models: {
				currentModelId: "gpt-5.2",
				availableModels: [{ modelId: "gpt-5.2", name: "GPT-5.2", description: "GPT-5.2" }],
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

	async prompt(promptText: string): Promise<any> {
		this.promptCalls.push(promptText);
		if (this.promptHandler) {
			return await this.promptHandler(promptText);
		}

		return { stopReason: "end_turn" };
	}

	async restartBackend(): Promise<any> {
		return await this.createSessionBackend();
	}

	async setNativeMode(modeId: NativeModeId): Promise<any> {
		this.modeCalls.push(modeId);
		await this.callbacks.onSessionUpdate({
			sessionId: this.nativeSessionId!,
			update: {
				sessionUpdate: "current_mode_update",
				currentModeId: modeId,
			},
		} as any);
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

function createAgentTestHarness() {
	const backends: FakeNativeBackend[] = [];
	const client = new FakeClient();

	const agent = new CursorAcpAgent(client as any, {
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
		runner: {
			async listModels() {
				return [
					{ modelId: "auto", name: "Auto", current: true },
					{ modelId: "gpt-5.2", name: "GPT-5.2" },
				];
			},
		} as any,
		createNativeClient(options, callbacks) {
			const backend = new FakeNativeBackend(options, callbacks, backends.length + 1);
			backends.push(backend);
			return backend;
		},
	});

	return { agent, backends, client };
}

function createLoggedOutAgentTestHarness() {
	const backends: FakeNativeBackend[] = [];
	const client = new FakeClient();

	const agent = new CursorAcpAgent(client as any, {
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
		} as any,
		createNativeClient(options, callbacks) {
			const backend = new FakeNativeBackend(options, callbacks, backends.length + 1);
			backends.push(backend);
			return backend;
		},
	});

	return { agent, backends, client };
}

async function startNativeBackend(agent: CursorAcpAgent, sessionId: string): Promise<void> {
	const session = (agent as any).sessions[sessionId];
	await (agent as any).ensureBackend(session);
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
		const { agent, backends, client } = createAgentTestHarness();

		await agent.initialize({
			protocolVersion: 1,
			clientCapabilities: {},
		} as any);
		const session = await agent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		} as any);

		const response = await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "/status" }],
		} as any);

		expect(response.stopReason).toBe("end_turn");
		expect(backends).toHaveLength(0);
		expect(client.updates.some((u) => u.update?.sessionUpdate === "agent_message_chunk")).toBe(
			true,
		);
	});

	it("forwards colliding slash commands to the native backend", async () => {
		const { agent, backends } = createAgentTestHarness();

		await agent.initialize({
			protocolVersion: 1,
			clientCapabilities: {},
		} as any);
		const session = await agent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		} as any);
		await startNativeBackend(agent, session.sessionId);

		const response = await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "/mode plan" }],
		} as any);

		expect(response.stopReason).toBe("end_turn");
		expect(backends[0]!.promptCalls).toEqual(["/mode plan"]);
		expect((agent as any).sessions[session.sessionId]?.modeId).toBe("default");
	});

	it("merges native available commands with wrapper built-ins", async () => {
		const { agent, client } = createAgentTestHarness();

		await agent.initialize({
			protocolVersion: 1,
			clientCapabilities: {},
		} as any);
		const session = await agent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		} as any);
		await startNativeBackend(agent, session.sessionId);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const commandsUpdate = client.updates.find(
			(update) => update.update?.sessionUpdate === "available_commands_update",
		);
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

		await agent.initialize({
			protocolVersion: 1,
			clientCapabilities: {},
		} as any);
		const session = await agent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		} as any);
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

		await agent.initialize({
			protocolVersion: 1,
			clientCapabilities: {},
		} as any);

		const session = await agent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		} as any);

		expect(session.models?.currentModelId).toBe("auto");
		expect(backends).toHaveLength(0);

		await expect(
			agent.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "hello" }],
			} as any),
		).rejects.toThrow("Authentication required");

		expect(backends).toHaveLength(0);
	});

	it("uses default mode by default", async () => {
		const { agent } = createAgentTestHarness();

		await agent.initialize({
			protocolVersion: 1,
			clientCapabilities: {},
		} as any);

		const session = await agent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		} as any);

		expect(session.modes?.currentModeId).toBe("default");
	});

	it("does not start the native backend when changing mode before first prompt", async () => {
		const { agent, backends } = createAgentTestHarness();

		await agent.initialize({
			protocolVersion: 1,
			clientCapabilities: {},
		} as any);
		const session = await agent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		} as any);

		await agent.setSessionMode({
			sessionId: session.sessionId,
			modeId: "plan",
		} as any);

		expect(backends).toHaveLength(0);
	});

	it("reports terminal auth metadata using the configured native command", async () => {
		const agent = new CursorAcpAgent({} as any, {
			nativeCommand: "cursor-agent",
		});

		const response = await agent.initialize({
			protocolVersion: 1,
			clientCapabilities: { _meta: { "terminal-auth": true } },
		} as any);

		expect(response.authMethods?.[0]?._meta?.["terminal-auth"]).toMatchObject({
			command: "cursor-agent",
			args: ["login"],
		});
	});

	it("does not restart the backend when /model runs before first prompt", async () => {
		const { agent, backends } = createAgentTestHarness();

		await agent.initialize({
			protocolVersion: 1,
			clientCapabilities: {},
		} as any);
		const session = await agent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		} as any);

		const recordSpy = vi.spyOn(agent as any, "restartBackend");

		const response = await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "/model gpt-5.2" }],
		} as any);

		expect(response.stopReason).toBe("end_turn");
		expect(backends).toHaveLength(0);
		expect(recordSpy).not.toHaveBeenCalled();

		recordSpy.mockRestore();
	});

	it("forwards permission requests in default mode", async () => {
		const { agent, backends, client } = createAgentTestHarness();

		await agent.initialize({
			protocolVersion: 1,
			clientCapabilities: {},
		} as any);
		const session = await agent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		} as any);
		await startNativeBackend(agent, session.sessionId);

		backends[0]!.promptHandler = async () => {
			await backends[0]!.callbacks.onRequestPermission({
				sessionId: backends[0]!.nativeSessionId!,
				options: [
					{
						optionId: "allow-once",
						kind: "allow_once",
						name: "Allow once",
					},
				],
				toolCall: {
					toolCallId: "t1",
					title: "`pwd`",
					rawInput: { command: "pwd" },
				},
			} as any);
			return { stopReason: "end_turn" };
		};

		await agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "run pwd" }],
		} as any);

		expect(client.permissionCalls).toHaveLength(1);
	});

	it("auto-approves permission requests in yolo mode", async () => {
		const { agent, backends, client } = createAgentTestHarness();

		await agent.initialize({
			protocolVersion: 1,
			clientCapabilities: {},
		} as any);
		const session = await agent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		} as any);
		await startNativeBackend(agent, session.sessionId);
		await agent.setSessionMode({
			sessionId: session.sessionId,
			modeId: "yolo",
		} as any);

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
			} as any);
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
		} as any);

		expect(client.permissionCalls).toHaveLength(0);
	});

	it("maps wrapper plan mode to native plan mode and emits updates", async () => {
		const { agent, backends, client } = createAgentTestHarness();

		await agent.initialize({
			protocolVersion: 1,
			clientCapabilities: {},
		} as any);
		const session = await agent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		} as any);
		await startNativeBackend(agent, session.sessionId);

		await agent.setSessionMode({
			sessionId: session.sessionId,
			modeId: "plan",
		} as any);

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

		await agent.initialize({
			protocolVersion: 1,
			clientCapabilities: {},
		} as any);
		const session = await agent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		} as any);
		await startNativeBackend(agent, session.sessionId);

		await agent.unstable_setSessionModel({
			sessionId: session.sessionId,
			modelId: "gpt-5.2",
		} as any);

		expect(backends).toHaveLength(2);
		expect(backends[0]!.closeCalls).toBe(1);
		expect(backends[1]!.options.modelId).toBe("gpt-5.2");
	});

	it("rejects a second prompt while one is in progress", async () => {
		const { agent, backends } = createAgentTestHarness();

		await agent.initialize({
			protocolVersion: 1,
			clientCapabilities: {},
		} as any);
		const session = await agent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		} as any);
		await startNativeBackend(agent, session.sessionId);

		let resolvePrompt: (() => void) | undefined;
		backends[0]!.promptHandler = async () =>
			await new Promise<{ stopReason: "end_turn" }>((resolve) => {
				resolvePrompt = () => resolve({ stopReason: "end_turn" });
			});

		const first = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "run something" }],
		} as any);
		while (backends[0]!.promptCalls.length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		await expect(
			agent.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "second" }],
			} as any),
		).rejects.toThrow(/another prompt is in progress/);

		resolvePrompt?.();
		await first;
	});

	it("rejects model changes while a prompt is active", async () => {
		const { agent, backends } = createAgentTestHarness();

		await agent.initialize({
			protocolVersion: 1,
			clientCapabilities: {},
		} as any);
		const session = await agent.newSession({
			cwd: "/tmp",
			mcpServers: [],
		} as any);
		await startNativeBackend(agent, session.sessionId);

		let resolvePrompt: (() => void) | undefined;
		backends[0]!.promptHandler = async () =>
			await new Promise((resolve) => {
				resolvePrompt = () => resolve({ stopReason: "end_turn" });
			});

		const promptPromise = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "run something" }],
		} as any);
		while (backends[0]!.promptCalls.length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		await expect(
			agent.unstable_setSessionModel({
				sessionId: session.sessionId,
				modelId: "gpt-5.2",
			} as any),
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

			await agent.initialize({
				protocolVersion: 1,
				clientCapabilities: {},
			} as any);
			await agent.unstable_resumeSession({
				sessionId: "session-1",
				cwd: "/tmp/project",
				mcpServers: [],
			} as any);
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
			await recordSessionMeta("/tmp/project", "session-1", "be-native-1");

			await agent.initialize({
				protocolVersion: 1,
				clientCapabilities: {},
			} as any);
			await agent.unstable_resumeSession({
				sessionId: "session-1",
				cwd: "/tmp/project",
				mcpServers: [],
			} as any);
			await waitForScheduledUpdates();

			expect(backends).toHaveLength(1);
			expect(backends[0]!.loadCalls).toEqual(["be-native-1"]);
			expect(backends[0]!.createCalls).toBe(0);
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
			await recordSessionMeta("/tmp/project", "session-1", "be-native-1");

			await agent.initialize({
				protocolVersion: 1,
				clientCapabilities: {},
			} as any);
			const response = await agent.loadSession({
				sessionId: "session-1",
				cwd: "/tmp/project",
				mcpServers: [],
			} as any);
			await waitForScheduledUpdates();

			expect(backends).toHaveLength(1);
			expect(backends[0]!.loadCalls).toEqual(["be-native-1"]);
			expect(response.models?.currentModelId).toBe("gpt-5.2");
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
