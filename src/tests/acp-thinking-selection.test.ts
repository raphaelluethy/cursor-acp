import type {
	NewSessionRequest,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SetSessionConfigOptionRequest,
} from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { CursorAcpAgent } from "../cursor-acp-agent.js";
import type { CursorAcpClient } from "../cursor-acp-client.js";
import type { CursorPromptRun, CursorRunner } from "../cursor-runner.js";
import type { CursorModelDescriptor } from "../slash-commands.js";

const THINKING_MODEL: CursorModelDescriptor = {
	modelId: "composer-2.5",
	name: "Composer 2.5",
	parameters: [
		{
			id: "thinking",
			displayName: "Thinking",
			values: [
				{ value: "low", displayName: "Low" },
				{ value: "high", displayName: "High" },
			],
		},
	],
	variants: [
		{
			params: [{ id: "thinking", value: "low" }],
			isDefault: true,
		},
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
	async extMethod() {
		return {};
	},
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

describe("ACP thinking selection", () => {
	it("exposes a thinking config option for models that support it", async () => {
		const agent = new CursorAcpAgent(mockClient, {
			runner: createRunner([THINKING_MODEL]),
			logger: { error() {}, log() {} },
		});

		const session = await agent.newSession({
			cwd: "/tmp/workspace",
			mcpServers: [],
		} satisfies NewSessionRequest);

		const thinkingOption = session.configOptions?.find((option) => option.id === "thinking");
		expect(thinkingOption).toMatchObject({
			category: "thought_level",
			type: "select",
			currentValue: "low",
		});
		if (thinkingOption?.type !== "select") {
			throw new Error("Expected thinking config option to be a select");
		}
		expect(thinkingOption.options).toEqual([
			{ value: "low", name: "Low" },
			{ value: "high", name: "High" },
		]);
	});

	it("updates the thinking level via setSessionConfigOption", async () => {
		const agent = new CursorAcpAgent(mockClient, {
			runner: createRunner([THINKING_MODEL]),
			logger: { error() {}, log() {} },
		});

		const session = await agent.newSession({
			cwd: "/tmp/workspace",
			mcpServers: [],
		} satisfies NewSessionRequest);

		const response = await agent.setSessionConfigOption({
			sessionId: session.sessionId,
			configId: "thinking",
			value: "high",
		} satisfies SetSessionConfigOptionRequest);

		const thinkingOption = response.configOptions?.find((option) => option.id === "thinking");
		expect(thinkingOption).toMatchObject({ currentValue: "high", type: "select" });
	});

	it("omits the thinking option when the current model does not support it", async () => {
		const agent = new CursorAcpAgent(mockClient, {
			runner: createRunner([{ modelId: "gpt-5.4-medium", name: "GPT-5.4 Medium" }]),
			logger: { error() {}, log() {} },
		});

		const session = await agent.newSession({
			cwd: "/tmp/workspace",
			mcpServers: [],
		} satisfies NewSessionRequest);

		expect(session.configOptions?.some((option) => option.id === "thinking")).toBe(false);
	});
});
