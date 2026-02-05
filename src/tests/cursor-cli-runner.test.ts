import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CursorCliRunner } from "../cursor-cli-runner.js";

describe("CursorCliRunner", () => {
  it(
    "resolves after receiving a result event even if the process stays alive",
    async () => {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-"));
      const scriptPath = path.join(tempRoot, "fake-agent.js");

      const script = `#!/usr/bin/env node\n
afterResult();\n\nfunction afterResult() {\n  const event = { type: \"result\", subtype: \"success\", is_error: false };\n  process.stdout.write(JSON.stringify(event) + \"\\n\");\n  setTimeout(() => {}, 10000);\n}\n`;

      await writeFile(scriptPath, script, "utf8");
      await chmod(scriptPath, 0o755);

      const runner = new CursorCliRunner(scriptPath, { log() {} } as any);
      const run = runner.startPrompt({
        workspace: tempRoot,
        prompt: "hello",
      });

      const result = await run.completed;
      expect(result.resultEvent?.type).toBe("result");
    },
    7000,
  );
});
