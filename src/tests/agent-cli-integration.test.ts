import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import {
	AgentSideConnection,
	ClientSideConnection,
	ndJsonStream,
	type NewSessionResponse,
	type PromptResponse,
	type RequestPermissionRequest,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import { CursorAcpAgent } from "../cursor-acp-agent.js";
import { CursorCliRunner } from "../cursor-cli-runner.js";
import { nodeToWebReadable, nodeToWebWritable } from "../utils.js";
import { noopLogger } from "./test-support.js";

const originalCursorAcpConfigDir = process.env.CURSOR_ACP_CONFIG_DIR;
let tempConfigDir: string | undefined;
let tempScriptDir: string | undefined;

beforeEach(async () => {
	tempConfigDir = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-int-"));
	tempScriptDir = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-scripts-"));
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
	if (tempScriptDir) {
		await rm(tempScriptDir, { recursive: true, force: true });
		tempScriptDir = undefined;
	}
});

async function writeFakeAgentScript(name: string, scriptBody: string): Promise<string> {
	const scriptPath = path.join(tempScriptDir!, name);
	const script = `#!/usr/bin/env node\n${scriptBody}`;
	await writeFile(scriptPath, script, "utf8");
	await chmod(scriptPath, 0o755);
	return scriptPath;
}

interface ProtocolHarness {
	client: ClientSideConnection;
	agent: CursorAcpAgent;
	clientUpdates: SessionNotification[];
	cleanup(): Promise<void>;
}

async function createProtocolHarness(
	agentFactory: (client: AgentSideConnection) => CursorAcpAgent,
): Promise<ProtocolHarness> {
	const agentStdin = new PassThrough();
	const agentStdout = new PassThrough();

	const clientStdin = agentStdout;
	const clientStdout = agentStdin;

	const agentStream = ndJsonStream(nodeToWebWritable(agentStdout), nodeToWebReadable(agentStdin));

	const clientStream = ndJsonStream(
		nodeToWebWritable(clientStdout),
		nodeToWebReadable(clientStdin),
	);

	const clientUpdates: SessionNotification[] = [];
	const client = new ClientSideConnection(
		() => ({
			sessionUpdate: async (params: SessionNotification) => {
				clientUpdates.push(params);
			},
			requestPermission: async (params: RequestPermissionRequest) => {
				const allowOption = params.options.find((option) => option.kind.startsWith("allow"));
				return {
					outcome: {
						outcome: "selected",
						optionId:
							allowOption?.optionId ?? params.options[0]?.optionId ?? "allow-once",
					},
				};
			},
			extMethod: async () => ({}),
			extNotification: async () => {},
			readTextFile: async () => ({ content: "" }),
			writeTextFile: async () => ({}),
		}),
		clientStream,
	);

	let agent: CursorAcpAgent | undefined;
	new AgentSideConnection((conn) => {
		agent = agentFactory(conn);
		return agent;
	}, agentStream);

	return {
		client,
		agent: agent!,
		clientUpdates,
		async cleanup() {
			agentStdin.end();
			agentStdout.end();
		},
	};
}

describe("CursorCliRunner integration", () => {
	it("runs a prompt end-to-end with a real child process", async () => {
		const scriptBody = `
const event = { type: "result", subtype: "success", is_error: false };
process.stdout.write(JSON.stringify(event) + "\\n");
`;
		const scriptPath = await writeFakeAgentScript("runner-success.js", scriptBody);
		const runner = new CursorCliRunner(scriptPath, noopLogger);

		const run = runner.startPrompt({
			workspace: tempScriptDir!,
			prompt: "hello",
		});

		const result = await run.completed;
		expect(result.resultEvent?.type).toBe("result");
		expect(result.resultEvent?.subtype).toBe("success");
		expect(result.exitCode).toBe(0);
	});

	it("streams multiple events before the result", async () => {
		const scriptBody = `
const events = [
  { type: "agent_message", text: "First" },
  { type: "agent_message", text: "Second" },
  { type: "result", subtype: "success", is_error: false },
];
for (const ev of events) {
  process.stdout.write(JSON.stringify(ev) + "\\n");
}
`;
		const scriptPath = await writeFakeAgentScript("runner-stream.js", scriptBody);
		const runner = new CursorCliRunner(scriptPath, noopLogger);

		const receivedEvents: unknown[] = [];
		const run = runner.startPrompt({
			workspace: tempScriptDir!,
			prompt: "hello",
			onEvent: (event) => {
				receivedEvents.push(event);
			},
		});

		const result = await run.completed;
		expect(result.events).toHaveLength(3);
		expect(receivedEvents).toHaveLength(3);
		expect(receivedEvents[0]?.type).toBe("agent_message");
		expect(receivedEvents[1]?.type).toBe("agent_message");
		expect(receivedEvents[2]?.type).toBe("result");
	});

	it("respects force flag in spawned arguments", async () => {
		const scriptBody = `
const force = process.argv.includes("--force");
const event = { type: "result", subtype: "success", is_error: false, force };
process.stdout.write(JSON.stringify(event) + "\\n");
`;
		const scriptPath = await writeFakeAgentScript("runner-force.js", scriptBody);
		const runner = new CursorCliRunner(scriptPath, noopLogger);

		const run = runner.startPrompt({
			workspace: tempScriptDir!,
			prompt: "hello",
			force: true,
		});

		const result = await run.completed;
		expect(result.resultEvent?.force).toBe(true);
	});

	it("respects mode flag in spawned arguments", async () => {
		const scriptBody = `
const modeIndex = process.argv.indexOf("--mode");
const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : null;
const event = { type: "result", subtype: "success", is_error: false, mode };
process.stdout.write(JSON.stringify(event) + "\\n");
`;
		const scriptPath = await writeFakeAgentScript("runner-mode.js", scriptBody);
		const runner = new CursorCliRunner(scriptPath, noopLogger);

		const run = runner.startPrompt({
			workspace: tempScriptDir!,
			prompt: "hello",
			modeId: "plan",
		});

		const result = await run.completed;
		expect(result.resultEvent?.mode).toBe("plan");
	});

	it("passes backendSessionId as --resume argument", async () => {
		const scriptBody = `
const resumeIndex = process.argv.indexOf("--resume");
const resumed = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : null;
const event = { type: "result", subtype: "success", is_error: false, resumed };
process.stdout.write(JSON.stringify(event) + "\\n");
`;
		const scriptPath = await writeFakeAgentScript("runner-resume.js", scriptBody);
		const runner = new CursorCliRunner(scriptPath, noopLogger);

		const run = runner.startPrompt({
			workspace: tempScriptDir!,
			prompt: "hello",
			backendSessionId: "sess-123",
		});

		const result = await run.completed;
		expect(result.resultEvent?.resumed).toBe("sess-123");
	});

	it("passes modelId as --model argument", async () => {
		const scriptBody = `
const modelIndex = process.argv.indexOf("--model");
const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : null;
const event = { type: "result", subtype: "success", is_error: false, model };
process.stdout.write(JSON.stringify(event) + "\\n");
`;
		const scriptPath = await writeFakeAgentScript("runner-model.js", scriptBody);
		const runner = new CursorCliRunner(scriptPath, noopLogger);

		const run = runner.startPrompt({
			workspace: tempScriptDir!,
			prompt: "hello",
			modelId: "gpt-5.4-medium",
		});

		const result = await run.completed;
		expect(result.resultEvent?.model).toBe("gpt-5.4-medium");
	});

	it("cancels an in-flight child process", async () => {
		const scriptBody = `
process.stdout.write(JSON.stringify({ type: "agent_message", text: "start" }) + "\\n");
setTimeout(() => {}, 10000);
`;
		const scriptPath = await writeFakeAgentScript("runner-slow.js", scriptBody);
		const runner = new CursorCliRunner(scriptPath, noopLogger);

		const run = runner.startPrompt({
			workspace: tempScriptDir!,
			prompt: "hello",
		});

		setTimeout(() => run.cancel(), 300);

		await expect(run.completed).rejects.toThrow(/exited without result event/);
	});

	it("surfaces stderr when the process exits without a result event", async () => {
		const scriptBody = `
process.stderr.write("something is broken\\n");
process.stdout.write(JSON.stringify({ type: "other" }) + "\\n");
`;
		const scriptPath = await writeFakeAgentScript("runner-no-result.js", scriptBody);
		const runner = new CursorCliRunner(scriptPath, noopLogger);

		const run = runner.startPrompt({
			workspace: tempScriptDir!,
			prompt: "hello",
		});

		await expect(run.completed).rejects.toThrow(/something is broken/);
	});

	it("lists models by parsing --list-models output", async () => {
		const scriptBody = `
console.log("  auto - Auto-select model (current)");
console.log("  gpt-5.4-medium - GPT-5.4");
console.log("  claude-4.5-opus-high - Claude 4.5 Opus");
`;
		const scriptPath = await writeFakeAgentScript("runner-list-models.js", scriptBody);
		const runner = new CursorCliRunner(scriptPath, noopLogger);

		const models = await runner.listModels();
		expect(models.map((m) => m.modelId)).toEqual([
			"auto",
			"gpt-5.4-medium",
			"claude-4.5-opus-high",
		]);
		expect(models[0]?.current).toBe(true);
	});

	it("creates a chat and extracts the session id", async () => {
		const scriptBody = `
console.log("Created new chat");
console.log("chat-abc-123");
`;
		const scriptPath = await writeFakeAgentScript("runner-create-chat.js", scriptBody);
		const runner = new CursorCliRunner(scriptPath, noopLogger);

		const id = await runner.createChat();
		expect(id).toBe("chat-abc-123");
	});
});

describe("CursorAcpAgent + CursorCliRunner integration", () => {
	it("prompts through a real runner and receives ACP notifications", async () => {
		const scriptBody = `
const chunks = [
  { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
  { type: "assistant", message: { content: [{ type: "text", text: " from" }] } },
  { type: "assistant", message: { content: [{ type: "text", text: " CLI" }] } },
  { type: "result", subtype: "success", is_error: false },
];
for (const chunk of chunks) {
  process.stdout.write(JSON.stringify(chunk) + "\\n");
}
`;
		const scriptPath = await writeFakeAgentScript("agent-integration-stream.js", scriptBody);
		const runner = new CursorCliRunner(scriptPath, noopLogger);

		const { client, clientUpdates, cleanup } = await createProtocolHarness(
			(clientConn) =>
				new CursorAcpAgent(clientConn, {
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
					createNativeClient() {
						return {
							alive: false,
							async cancel() {},
							async close() {},
							async createSessionBackend() {
								return { sessionId: "native-1" };
							},
							async loadSessionBackend() {
								return {};
							},
							async prompt() {
								return { stopReason: "end_turn" };
							},
							async restartBackend() {
								return { sessionId: "native-1" };
							},
							async setNativeMode() {
								return {};
							},
							nativeSessionId: undefined,
						};
					},
				}),
		);

		try {
			await client.initialize({
				protocolVersion: 1,
				clientCapabilities: {},
				clientInfo: { name: "test", version: "1.0.0" },
			});

			const session = await client.newSession({
				cwd: tempScriptDir!,
				mcpServers: [],
			});

			const promptResponse = await client.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "hello" }],
			});

			expect(promptResponse.stopReason).toBe("end_turn");

			await new Promise((resolve) => setTimeout(resolve, 100));

			const chunks = clientUpdates.filter(
				(u) => u.update?.sessionUpdate === "agent_message_chunk",
			);
			const text = chunks.map((u) => u.update?.content?.text).join("");
			expect(text).toBe("Hello from CLI");
		} finally {
			await cleanup();
		}
	}, 15000);

	it("handles tool calls through the real runner", async () => {
		const scriptBody = `
const started = {
  type: "tool_call",
  subtype: "started",
  call_id: "tc-1",
  tool_call: { shellToolCall: { args: { command: "pwd" } } },
};
const completed = {
  type: "tool_call",
  subtype: "completed",
  call_id: "tc-1",
  tool_call: {
    shellToolCall: {
      args: { command: "pwd" },
      result: { success: { output: "/tmp", exitCode: 0 } },
    },
  },
};
const result = { type: "result", subtype: "success", is_error: false };

process.stdout.write(JSON.stringify(started) + "\\n");
setTimeout(() => {
  process.stdout.write(JSON.stringify(completed) + "\\n");
  process.stdout.write(JSON.stringify(result) + "\\n");
}, 200);
`;
		const scriptPath = await writeFakeAgentScript("agent-integration-tool.js", scriptBody);
		const runner = new CursorCliRunner(scriptPath, noopLogger);

		const { client, clientUpdates, cleanup } = await createProtocolHarness(
			(clientConn) =>
				new CursorAcpAgent(clientConn, {
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
					createNativeClient() {
						return {
							alive: false,
							async cancel() {},
							async close() {},
							async createSessionBackend() {
								return { sessionId: "native-1" };
							},
							async loadSessionBackend() {
								return {};
							},
							async prompt() {
								return { stopReason: "end_turn" };
							},
							async restartBackend() {
								return { sessionId: "native-1" };
							},
							async setNativeMode() {
								return {};
							},
							nativeSessionId: undefined,
						};
					},
				}),
		);

		try {
			await client.initialize({
				protocolVersion: 1,
				clientCapabilities: {},
				clientInfo: { name: "test", version: "1.0.0" },
			});

			const session = await client.newSession({
				cwd: tempScriptDir!,
				mcpServers: [],
			});

			const promptResponse = await client.prompt({
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "run command" }],
			});

			expect(promptResponse.stopReason).toBe("end_turn");

			await new Promise((resolve) => setTimeout(resolve, 100));

			const toolCalls = clientUpdates.filter((u) => u.update?.sessionUpdate === "tool_call");
			expect(toolCalls.length).toBeGreaterThanOrEqual(1);
		} finally {
			await cleanup();
		}
	}, 15000);

	it("rejects prompt when auth is required", async () => {
		const runner = new CursorCliRunner("/dev/null", noopLogger);

		const { client, cleanup } = await createProtocolHarness(
			(clientConn) =>
				new CursorAcpAgent(clientConn, {
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
					runner,
					createNativeClient() {
						return {
							alive: false,
							async cancel() {},
							async close() {},
							async createSessionBackend() {
								return { sessionId: "native-1" };
							},
							async loadSessionBackend() {
								return {};
							},
							async prompt() {
								return { stopReason: "end_turn" };
							},
							async restartBackend() {
								return { sessionId: "native-1" };
							},
							async setNativeMode() {
								return {};
							},
							nativeSessionId: undefined,
						};
					},
				}),
		);

		try {
			await client.initialize({
				protocolVersion: 1,
				clientCapabilities: {},
				clientInfo: { name: "test", version: "1.0.0" },
			});

			const session = await client.newSession({
				cwd: tempScriptDir!,
				mcpServers: [],
			});

			await expect(
				client.prompt({
					sessionId: session.sessionId,
					prompt: [{ type: "text", text: "hello" }],
				}),
			).rejects.toThrow(/Authentication required/);
		} finally {
			await cleanup();
		}
	}, 10000);
});
