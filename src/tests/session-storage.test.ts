import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	appendSessionEntry,
	findSessionFile,
	listSessions,
	readSessionMeta,
	recordAssistantMessage,
	recordSessionMeta,
	recordUserMessage,
	replaySessionHistory,
	sessionFilePath,
} from "../session-storage.js";
import { SessionNotification } from "@agentclientprotocol/sdk";

describe("session-storage", () => {
	let tempDir: string;
	let originalConfigDir: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-acp-test-"));
		originalConfigDir = process.env.CURSOR_ACP_CONFIG_DIR;
		process.env.CURSOR_ACP_CONFIG_DIR = tempDir;
	});

	afterEach(() => {
		if (originalConfigDir !== undefined) {
			process.env.CURSOR_ACP_CONFIG_DIR = originalConfigDir;
		} else {
			delete process.env.CURSOR_ACP_CONFIG_DIR;
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("persists conversation history and session metadata", async () => {
		const cwd = "/Users/test/project";
		const sessionId = "test-session";

		await recordUserMessage(cwd, sessionId, "Hello world");
		await recordAssistantMessage(cwd, sessionId, "I can help with that");
		await recordSessionMeta(cwd, sessionId, {
			backendSessionId: "backend-2",
			modeId: "yolo",
			thinkingLevel: "high",
			thoughtParamId: "reasoning",
			fastValue: "false",
		});

		const meta = await readSessionMeta(sessionFilePath(cwd, sessionId));
		expect(meta).toEqual({
			backendSessionId: "backend-2",
			modeId: "yolo",
			thinkingLevel: "high",
			thoughtParamId: "reasoning",
			fastValue: "false",
		});

		const filePath = sessionFilePath(cwd, sessionId);
		const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(3);
	});

	it("finds persisted sessions for resume", async () => {
		const cwd = "/Users/test/project";
		const sessionId = "test-session";

		await recordUserMessage(cwd, sessionId, "Hello");

		expect(await findSessionFile(sessionId, cwd)).toContain(sessionId);
		expect(await findSessionFile("non-existent", cwd)).toBeNull();
		expect(await findSessionFile(sessionId, "/Users/test/other")).toContain(sessionId);
	});

	it("lists sessions with titles derived from conversation history", async () => {
		const cwd = "/Users/test/project";

		await appendSessionEntry(cwd, "array-title", {
			type: "user",
			timestamp: new Date().toISOString(),
			sessionId: "array-title",
			cwd,
			message: {
				role: "user",
				content: [{ type: "text", text: "Fix login bug" }],
			},
		});

		const sessions = await listSessions(cwd);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			sessionId: "array-title",
			title: "Fix login bug",
			cwd,
		});
	});

	it("replays session history as ACP notifications", async () => {
		const cwd = "/Users/test/project";
		const sessionId = "test-session";

		await recordUserMessage(cwd, sessionId, "Hello");
		await recordAssistantMessage(cwd, sessionId, "Hi there");
		await appendSessionEntry(cwd, sessionId, {
			type: "user",
			timestamp: new Date().toISOString(),
			sessionId: "other-session",
			message: { role: "user", content: "Should be skipped" },
		});
		await appendSessionEntry(cwd, sessionId, {
			type: "assistant",
			timestamp: new Date().toISOString(),
			sessionId,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Part 1" }, { text: "Part 2" }],
			},
		});

		const notifications: SessionNotification[] = [];
		await replaySessionHistory({
			sessionId,
			filePath: sessionFilePath(cwd, sessionId),
			sendNotification: async (notification) => {
				notifications.push(notification);
			},
		});

		expect(notifications).toHaveLength(3);
		expect(notifications[0].update.sessionUpdate).toBe("user_message_chunk");
		expect(notifications[1].update.sessionUpdate).toBe("agent_message_chunk");
		expect(notifications[2].update).toMatchObject({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "Part 1Part 2" },
		});
	});
});
