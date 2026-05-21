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

function createRunner(): CursorRunner {
	return {
		async listModels() {
			return [{ modelId: "gpt-5.4-medium", name: "GPT-5.4 Medium" }];
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

describe("ACP model selection", () => {
	it("keeps auto selectable when the SDK model list omits it", async () => {
		const agent = new CursorAcpAgent(mockClient, {
			runner: createRunner(),
			logger: { error() {}, log() {} },
		});

		const session = await agent.newSession({
			cwd: "/tmp/workspace",
			mcpServers: [],
		} satisfies NewSessionRequest);

		const response = await agent.setSessionConfigOption({
			sessionId: session.sessionId,
			configId: "model",
			value: "auto",
		} satisfies SetSessionConfigOptionRequest);

		const modelOption = response.configOptions?.find((option) => option.id === "model");
		expect(modelOption).toMatchObject({ currentValue: "auto", type: "select" });
		if (modelOption?.type !== "select") {
			throw new Error("Expected model config option to be a select");
		}
		expect(modelOption.options).toContainEqual(
			expect.objectContaining({ value: "auto", name: "Auto" }),
		);
	});
});
