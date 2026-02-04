import { describe, expect, it } from "vitest";
import { handleSlashCommand, parseModelListOutput } from "../slash-commands.js";

const mockAuth = {
  async status() {
    return { loggedIn: true as const, account: "user@example.com", raw: "" };
  },
  async login() {
    return { code: 0, stdout: "", stderr: "" };
  },
  async logout() {
    return { code: 0, stdout: "", stderr: "" };
  },
  async ensureLoggedIn() {
    return { loggedIn: true as const, account: "user@example.com", raw: "" };
  },
};

describe("slash commands", () => {
  it("parses model output", () => {
    const parsed = parseModelListOutput(
      `Available models\nauto - Auto\ngpt-5.2 - GPT-5.2 (current)`,
    );
    expect(parsed).toEqual([
      { modelId: "auto", name: "Auto", current: false },
      { modelId: "gpt-5.2", name: "GPT-5.2", current: true },
    ]);
  });

  it("handles /model set", async () => {
    const session = { modelId: "auto", modeId: "default" as const };
    const result = await handleSlashCommand("model", "gpt-5.2", {
      session,
      auth: mockAuth,
      listModels: async () => [
        { modelId: "auto", name: "Auto" },
        { modelId: "gpt-5.2", name: "GPT-5.2" },
      ],
    });

    expect(result.handled).toBe(true);
    expect(result.responseText).toContain("Model set to gpt-5.2");
    expect(session.modelId).toBe("gpt-5.2");
  });

  it("handles /mode set", async () => {
    const session = { modelId: "auto", modeId: "default" as const };
    const result = await handleSlashCommand("mode", "plan", {
      session,
      auth: mockAuth,
      listModels: async () => [],
    });

    expect(result.handled).toBe(true);
    expect(result.responseText).toContain("Mode set to plan");
    expect(session.modeId).toBe("plan");
  });
});
