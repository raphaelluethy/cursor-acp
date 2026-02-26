import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CursorCliRunner } from "../cursor-cli-runner.js";

describe("CursorCliRunner", () => {
	it("resolves after receiving a result event even if the process stays alive", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-"));
		const scriptPath = path.join(tempRoot, "fake-agent.js");

		const script = `#!/usr/bin/env node\n
afterResult();\n\nfunction afterResult() {\n  const event = { type: "result", subtype: "success", is_error: false };\n  process.stdout.write(JSON.stringify(event) + "\\n");\n  setTimeout(() => {}, 10000);\n}\n`;

		await writeFile(scriptPath, script, "utf8");
		await chmod(scriptPath, 0o755);

		const runner = new CursorCliRunner(scriptPath, { log() {} } as any);
		const run = runner.startPrompt({
			workspace: tempRoot,
			prompt: "hello",
		});

		const result = await run.completed;
		expect(result.resultEvent?.type).toBe("result");
	}, 7000);

	it("does not resolve while a tool call is still running", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-"));
		const scriptPath = path.join(tempRoot, "fake-agent-with-tool.js");

		const script = `#!/usr/bin/env node\n
const started = {
  type: "tool_call",
  subtype: "started",
  call_id: "call-1",
  tool_call: { name: "bash", arguments: "{}" },
};
const result = { type: "result", subtype: "success", is_error: false };
const completed = {
  type: "tool_call",
  subtype: "completed",
  call_id: "call-1",
  tool_call: {
    name: "bash",
    arguments: JSON.stringify({
      result: { success: { output: "done", exitCode: 0 } },
    }),
  },
};

process.stdout.write(JSON.stringify(started) + "\\n");
process.stdout.write(JSON.stringify(result) + "\\n");
setTimeout(() => {
  process.stdout.write(JSON.stringify(completed) + "\\n");
  process.exit(0);
}, 700);
`;

		await writeFile(scriptPath, script, "utf8");
		await chmod(scriptPath, 0o755);

		const runner = new CursorCliRunner(scriptPath, { log() {} } as any);
		const run = runner.startPrompt({
			workspace: tempRoot,
			prompt: "hello",
		});

		const startedAt = Date.now();
		const result = await run.completed;
		const elapsedMs = Date.now() - startedAt;

		expect(result.resultEvent?.type).toBe("result");
		expect(elapsedMs).toBeGreaterThanOrEqual(650);
		expect(
			result.events.some(
				(event) => event.type === "tool_call" && event.subtype === "completed",
			),
		).toBe(true);
	}, 7000);
});
