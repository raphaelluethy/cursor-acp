import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CursorAcpAgent } from "../cursor-acp-agent.js";

class FakeClient {
  updates: any[] = [];
  permissionCalls: any[] = [];

  async sessionUpdate(params: any): Promise<void> {
    this.updates.push(params);
  }

  async requestPermission(params: any): Promise<any> {
    this.permissionCalls.push(params);
    return { outcome: { outcome: "selected", optionId: "allow_once" } };
  }

  async readTextFile(_params: any): Promise<any> {
    return { content: "" };
  }

  async writeTextFile(_params: any): Promise<any> {
    return {};
  }
}

describe("CursorAcpAgent", () => {
  it("handles slash command in prompt", async () => {
    const client = new FakeClient();
    let promptCalls = 0;

    const runner: any = {
      async listModels() {
        return [{ modelId: "auto", name: "Auto", current: true }];
      },
      async createChat() {
        return "chat-1";
      },
      startPrompt() {
        promptCalls += 1;
        return {
          cancel() {},
          completed: Promise.resolve({
            events: [],
            resultEvent: {
              type: "result",
              subtype: "success",
              is_error: false,
            },
            stderr: "",
            exitCode: 0,
          }),
        };
      },
    };

    const auth: any = {
      async status() {
        return { loggedIn: true, account: "u@e", raw: "" };
      },
      async ensureLoggedIn() {
        return { loggedIn: true, account: "u@e", raw: "" };
      },
      async login() {
        return { code: 0, stdout: "", stderr: "" };
      },
      async logout() {
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    const agent = new CursorAcpAgent(client as any, { runner, auth });
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
    expect(promptCalls).toBe(0);
    expect(
      client.updates.some(
        (u) => u.update?.sessionUpdate === "agent_message_chunk",
      ),
    ).toBe(true);
  });

  it("retries with force after permission on rejected tool", async () => {
    const client = new FakeClient();
    let runCount = 0;

    const runner: any = {
      async listModels() {
        return [{ modelId: "auto", name: "Auto", current: true }];
      },
      async createChat() {
        return "chat-1";
      },
      startPrompt(_opts: any) {
        runCount += 1;

        if (runCount === 1) {
          return {
            cancel() {},
            completed: Promise.resolve({
              events: [],
              resultEvent: {
                type: "result",
                subtype: "success",
                is_error: false,
              },
              stderr: "",
              exitCode: 0,
            }),
          };
        }

        return {
          cancel() {},
          completed: Promise.resolve({
            events: [],
            resultEvent: {
              type: "result",
              subtype: "success",
              is_error: false,
            },
            stderr: "",
            exitCode: 0,
          }),
        };
      },
    };

    const auth: any = {
      async status() {
        return { loggedIn: true, account: "u@e", raw: "" };
      },
      async ensureLoggedIn() {
        return { loggedIn: true, account: "u@e", raw: "" };
      },
      async login() {
        return { code: 0, stdout: "", stderr: "" };
      },
      async logout() {
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    const agent = new CursorAcpAgent(client as any, { runner, auth });
    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    } as any);
    const session = await agent.newSession({
      cwd: "/tmp",
      mcpServers: [],
    } as any);

    // inject a fake rejected call by monkey-patching private method path through any
    const original = (agent as any).runPromptAttempt.bind(agent);
    let calls = 0;
    (agent as any).runPromptAttempt = async (...args: any[]) => {
      calls += 1;
      if (calls === 1) {
        return {
          stopReason: "end_turn",
          rejectedToolCalls: [
            {
              toolCallId: "t1",
              title: "`pwd`",
              rawInput: { command: "pwd" },
            },
          ],
        };
      }
      return await original(...args);
    };

    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "run pwd" }],
    } as any);

    expect(client.permissionCalls.length).toBe(1);
    expect(calls).toBe(2);
  });

  it("does not request permission after cancellation", async () => {
    const client = new FakeClient();

    const runner: any = {
      async listModels() {
        return [{ modelId: "auto", name: "Auto", current: true }];
      },
      async createChat() {
        return "chat-1";
      },
      startPrompt() {
        return {
          cancel() {},
          completed: Promise.resolve({
            events: [],
            resultEvent: {
              type: "result",
              subtype: "success",
              is_error: false,
            },
            stderr: "",
            exitCode: 0,
          }),
        };
      },
    };

    const auth: any = {
      async status() {
        return { loggedIn: true, account: "u@e", raw: "" };
      },
      async ensureLoggedIn() {
        return { loggedIn: true, account: "u@e", raw: "" };
      },
      async login() {
        return { code: 0, stdout: "", stderr: "" };
      },
      async logout() {
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    const agent = new CursorAcpAgent(client as any, { runner, auth });
    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    } as any);
    const session = await agent.newSession({
      cwd: "/tmp",
      mcpServers: [],
    } as any);

    (agent as any).runPromptAttempt = async () => ({
      stopReason: "cancelled",
      rejectedToolCalls: [
        {
          toolCallId: "t1",
          title: "`pwd`",
          rawInput: { command: "pwd" },
        },
      ],
    });

    const response = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "run pwd" }],
    } as any);

    expect(response.stopReason).toBe("cancelled");
    expect(client.permissionCalls.length).toBe(0);
  });

  it("returns cancelled when slash command is cancelled", async () => {
    const client = new FakeClient();

    const runner: any = {
      async listModels() {
        return [{ modelId: "auto", name: "Auto", current: true }];
      },
      async createChat() {
        return "chat-1";
      },
      startPrompt() {
        throw new Error("startPrompt should not be called for /status");
      },
    };

    let authCalls = 0;
    const auth: any = {
      async status() {
        authCalls += 1;
        if (authCalls === 2) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return { loggedIn: true, account: "u@e", raw: "" };
      },
      async ensureLoggedIn() {
        return { loggedIn: true, account: "u@e", raw: "" };
      },
      async login() {
        return { code: 0, stdout: "", stderr: "" };
      },
      async logout() {
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    const agent = new CursorAcpAgent(client as any, { runner, auth });
    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    } as any);
    const session = await agent.newSession({
      cwd: "/tmp",
      mcpServers: [],
    } as any);

    const promptPromise = agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/status" }],
    } as any);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await agent.cancel({ sessionId: session.sessionId } as any);

    const response = await promptPromise;
    expect(response.stopReason).toBe("cancelled");
  });

  it("forwards custom slash command prompts to cursor cli", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-agent-"));
    const commandsDir = path.join(tempRoot, ".cursor", "commands");
    await mkdir(commandsDir, { recursive: true });
    await writeFile(
      path.join(commandsDir, "commit.md"),
      [
        "---",
        "description: Commit helper",
        "argument-hint: <scope>",
        "---",
        "Write a concise conventional commit message.",
        "Scope: $ARGUMENTS",
      ].join("\n"),
      "utf8",
    );

    const client = new FakeClient();
    let promptText = "";

    const runner: any = {
      async listModels() {
        return [{ modelId: "auto", name: "Auto", current: true }];
      },
      async createChat() {
        return "chat-1";
      },
      startPrompt(options: any) {
        promptText = options.prompt;
        return {
          cancel() {},
          completed: Promise.resolve({
            events: [],
            resultEvent: {
              type: "result",
              subtype: "success",
              is_error: false,
            },
            stderr: "",
            exitCode: 0,
          }),
        };
      },
    };

    const auth: any = {
      async status() {
        return { loggedIn: true, account: "u@e", raw: "" };
      },
      async ensureLoggedIn() {
        return { loggedIn: true, account: "u@e", raw: "" };
      },
      async login() {
        return { code: 0, stdout: "", stderr: "" };
      },
      async logout() {
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    try {
      const agent = new CursorAcpAgent(client as any, { runner, auth });
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      } as any);
      const session = await agent.newSession({
        cwd: tempRoot,
        mcpServers: [],
      } as any);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const commandsUpdate = client.updates.find(
        (u) => u.update?.sessionUpdate === "available_commands_update",
      );
      expect(
        commandsUpdate?.update?.availableCommands?.some(
          (command: any) => command.name === "commit",
        ),
      ).toBe(true);

      const response = await agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "/commit feat(parser)" }],
      } as any);

      expect(response.stopReason).toBe("end_turn");
      expect(promptText).toBe(
        "Write a concise conventional commit message.\nScope: feat(parser)",
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
