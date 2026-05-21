import type {
	NewSessionRequest,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SetSessionConfigOptionRequest,
	SessionNotification,
} from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { CursorAcpAgent } from "../cursor-acp-agent.js";
import type { CursorAcpClient } from "../cursor-acp-client.js";
import type { CursorPromptRun, CursorRunner } from "../cursor-runner.js";
import type { CursorModelDescriptor } from "../slash-commands.js";

type ExtendedNewSessionRequest = NewSessionRequest & { modelId: string };

const REASONING_MODEL: CursorModelDescriptor = {
	modelId: "gpt-5.5",
	name: "GPT-5.5",
	current: true,
	parameters: [
		{
			id: "reasoning",
			displayName: "Reasoning",
			values: [
				{ value: "none", displayName: "None" },
				{ value: "medium", displayName: "Medium" },
				{ value: "high", displayName: "High" },
			],
		},
	],
	variants: [
		{
			params: [
				{ id: "context", value: "1m" },
				{ id: "reasoning", value: "medium" },
				{ id: "fast", value: "false" },
			],
			isDefault: true,
		},
	],
};

const THINKING_MODEL: CursorModelDescriptor = {
	modelId: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	parameters: [
		{
			id: "thinking",
			displayName: "Thinking",
			values: [{ value: "false" }, { value: "true", displayName: "On" }],
		},
		{
			id: "effort",
			displayName: "Effort",
			values: [
				{ value: "low", displayName: "Low" },
				{ value: "high", displayName: "High" },
			],
		},
	],
	variants: [
		{
			params: [
				{ id: "thinking", value: "true" },
				{ id: "effort", value: "medium" },
			],
			isDefault: true,
		},
	],
};

const FAST_MODEL: CursorModelDescriptor = {
	modelId: "composer-2.5",
	name: "Composer 2.5",
	parameters: [
		{
			id: "fast",
			displayName: "Fast",
			values: [{ value: "false" }, { value: "true", displayName: "Fast" }],
		},
	],
	variants: [
		{ params: [{ id: "fast", value: "true" }], isDefault: true },
		{ params: [{ id: "fast", value: "false" }] },
	],
};

const mockClient: CursorAcpClient = {
	async sessionUpdate() {},
	async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		return { outcome: { outcome: "selected", optionId: "allow" } };
	},
	async readTextFile() {
		return { content: "" };
	},
	async writeTextFile() {
		return {};
	},
	async extMethod() {},
	async extNotification() {},
};

function createRunner(models: CursorModelDescriptor[]): CursorRunner {
	return {
		async listModels() {
			return models;
		},
		async createChat() {
			return "pending-test";
		},
		startPrompt(): CursorPromptRun {
			return {
				completed: Promise.resolve({ events: [], stderr: "", exitCode: 0 }),
				cancel() {},
			};
		},
	};
}

describe("ACP session config options", () => {
	it("exposes and updates thought level config for supported models", async () => {
		const agent = new CursorAcpAgent(mockClient, {
			runner: createRunner([REASONING_MODEL]),
			logger: { error() {}, log() {} },
		});

		const session = await agent.newSession({
			cwd: "/tmp/workspace",
			mcpServers: [],
			modelId: "gpt-5.5",
		} as ExtendedNewSessionRequest);

		const thoughtOption = session.configOptions?.find((option) => option.id === "reasoning");
		expect(thoughtOption).toMatchObject({
			category: "thought_level",
			type: "select",
			currentValue: "medium",
		});

		const optionIds = session.configOptions?.map((option) => option.id) ?? [];
		expect(optionIds.indexOf("reasoning")).toBeLessThan(optionIds.indexOf("model"));

		const response = await agent.setSessionConfigOption({
			sessionId: session.sessionId,
			configId: "reasoning",
			value: "high",
		} satisfies SetSessionConfigOptionRequest);

		expect(response.configOptions?.find((option) => option.id === "reasoning")).toMatchObject({
			currentValue: "high",
			type: "select",
		});
	});

	it("prefers effort over thinking when both are available", async () => {
		const agent = new CursorAcpAgent(mockClient, {
			runner: createRunner([THINKING_MODEL]),
			logger: { error() {}, log() {} },
		});

		const session = await agent.newSession({
			cwd: "/tmp/workspace",
			mcpServers: [],
			modelId: "claude-sonnet-4-6",
		} as ExtendedNewSessionRequest);

		const thoughtOption = session.configOptions?.find(
			(option) => option.category === "thought_level",
		);
		expect(thoughtOption?.id).toBe("effort");
	});

	it("hides model-specific config when auto is selected", async () => {
		const agent = new CursorAcpAgent(mockClient, {
			runner: createRunner([{ modelId: "auto", name: "Auto" }, REASONING_MODEL, FAST_MODEL]),
			logger: { error() {}, log() {} },
		});

		const session = await agent.newSession({
			cwd: "/tmp/workspace",
			mcpServers: [],
			modelId: "auto",
		} as ExtendedNewSessionRequest);

		expect(session.configOptions?.some((option) => option.id === "reasoning")).toBe(false);
		expect(session.configOptions?.some((option) => option.id === "fast")).toBe(false);
	});

	it("exposes and updates fast config for supported models", async () => {
		const agent = new CursorAcpAgent(mockClient, {
			runner: createRunner([FAST_MODEL]),
			logger: { error() {}, log() {} },
		});

		const session = await agent.newSession({
			cwd: "/tmp/workspace",
			mcpServers: [],
			modelId: "composer-2.5",
		} as ExtendedNewSessionRequest);

		expect(session.configOptions?.find((option) => option.id === "fast")).toMatchObject({
			category: "model",
			type: "select",
			currentValue: "true",
			options: [
				{ value: "false", name: "Default" },
				{ value: "true", name: "Fast" },
			],
		});

		const response = await agent.setSessionConfigOption({
			sessionId: session.sessionId,
			configId: "fast",
			value: "false",
		} satisfies SetSessionConfigOptionRequest);

		expect(response.configOptions?.find((option) => option.id === "fast")).toMatchObject({
			currentValue: "false",
			type: "select",
		});
	});

	it("applies nested cursor default_config_options before building session config", async () => {
		const agent = new CursorAcpAgent(mockClient, {
			runner: createRunner([FAST_MODEL]),
			logger: { error() {}, log() {} },
		});

		await agent.initialize({
			clientCapabilities: {},
			cursor: {
				default_config_options: {
					fast: "true",
					mode: "yolo",
					model: "composer-2.5",
				},
			},
		} as never);

		const session = await agent.newSession({
			cwd: "/tmp/workspace",
			mcpServers: [],
		} satisfies NewSessionRequest);

		expect(session.configOptions?.find((option) => option.id === "model")).toMatchObject({
			currentValue: "composer-2.5",
		});
		expect(session.configOptions?.find((option) => option.id === "mode")).toMatchObject({
			currentValue: "yolo",
		});
		expect(session.configOptions?.find((option) => option.id === "fast")).toMatchObject({
			currentValue: "true",
			type: "select",
		});
	});

	it("emits config option updates when switching away from auto", async () => {
		const notifications: SessionNotification[] = [];
		const agent = new CursorAcpAgent(
			{
				...mockClient,
				async sessionUpdate(notification) {
					notifications.push(notification);
				},
			},
			{
				runner: createRunner([{ modelId: "auto", name: "Auto" }, FAST_MODEL]),
				logger: { error() {}, log() {} },
			},
		);

		const session = await agent.newSession({
			cwd: "/tmp/workspace",
			mcpServers: [],
			modelId: "auto",
		} as ExtendedNewSessionRequest);

		await agent.setSessionConfigOption({
			sessionId: session.sessionId,
			configId: "model",
			value: "composer-2.5",
		} satisfies SetSessionConfigOptionRequest);

		const configUpdate = notifications.find(
			(notification) => notification.update.sessionUpdate === "config_option_update",
		);
		expect(configUpdate?.update).toMatchObject({
			sessionUpdate: "config_option_update",
			configOptions: [
				expect.objectContaining({ id: "mode" }),
				expect.objectContaining({ id: "fast", currentValue: "true" }),
				expect.objectContaining({ id: "model", currentValue: "composer-2.5" }),
			],
		});
	});
});
