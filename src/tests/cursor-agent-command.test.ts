import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_CURSOR_AGENT_COMMAND,
	getDefaultCursorAgentCommand,
} from "../cursor-agent-command.js";

const originalCursorAcpAgentCommand = process.env.CURSOR_ACP_AGENT_COMMAND;
const originalCursorAgentCommand = process.env.CURSOR_AGENT_COMMAND;

afterEach(() => {
	if (originalCursorAcpAgentCommand === undefined) {
		delete process.env.CURSOR_ACP_AGENT_COMMAND;
	} else {
		process.env.CURSOR_ACP_AGENT_COMMAND = originalCursorAcpAgentCommand;
	}

	if (originalCursorAgentCommand === undefined) {
		delete process.env.CURSOR_AGENT_COMMAND;
	} else {
		process.env.CURSOR_AGENT_COMMAND = originalCursorAgentCommand;
	}
});

describe("getDefaultCursorAgentCommand", () => {
	it("defaults to the current Cursor Agent CLI executable", () => {
		delete process.env.CURSOR_ACP_AGENT_COMMAND;
		delete process.env.CURSOR_AGENT_COMMAND;

		expect(getDefaultCursorAgentCommand()).toBe(DEFAULT_CURSOR_AGENT_COMMAND);
	});

	it("allows overriding the executable for older installs or tests", () => {
		process.env.CURSOR_ACP_AGENT_COMMAND = "agent";
		process.env.CURSOR_AGENT_COMMAND = "cursor-agent-ignored";

		expect(getDefaultCursorAgentCommand()).toBe("agent");
	});
});
