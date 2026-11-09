import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { runSessionResumeE2E } from "./sdk-session-resume-harness.js";

const isOptIn = process.env.CURSOR_ACP_E2E_REAL_MODEL === "1";

describe.skipIf(!isOptIn)("Cursor SDK Process-Kill Session Resume E2E", () => {
	it("retains SDK session and conversation history across SIGKILL via session/load", async () => {
		const result = await runSessionResumeE2E({
			recoveryMethod: "session/load",
			logFile:
				process.env.CURSOR_ACP_E2E_LOG_LOAD ||
				path.join(os.tmpdir(), "cursor-acp-e2e-session-load.log"),
			onLog: (line) => console.log(line),
		});
		expect(result.firstExitSignal).toBe("SIGKILL");
		expect(result.error).toBeUndefined();
		expect(result.backendSessionIdRetained).toBe(true);
		expect(result.tokenRetained).toBe(true);
		expect(result.toolCallsAttempted).toBe(0);
		expect(result.replayLeakedIntoTurn2).toBe(false);
		expect(result.turn2Reply).not.toContain("ACK");
		expect(result.passed).toBe(true);
	}, 180000);

	it("retains SDK session and conversation history across SIGKILL via session/resume", async () => {
		const result = await runSessionResumeE2E({
			recoveryMethod: "session/resume",
			logFile:
				process.env.CURSOR_ACP_E2E_LOG_RESUME ||
				path.join(os.tmpdir(), "cursor-acp-e2e-session-resume.log"),
			onLog: (line) => console.log(line),
		});
		expect(result.firstExitSignal).toBe("SIGKILL");
		expect(result.error).toBeUndefined();
		expect(result.backendSessionIdRetained).toBe(true);
		expect(result.tokenRetained).toBe(true);
		expect(result.toolCallsAttempted).toBe(0);
		expect(result.replayLeakedIntoTurn2).toBe(false);
		expect(result.turn2Reply).not.toContain("ACK");
		expect(result.passed).toBe(true);
	}, 180000);
});
