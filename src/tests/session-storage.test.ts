import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  encodeProjectPath,
  sessionFilePath,
  ensureSessionDir,
  appendSessionEntry,
  recordUserMessage,
  recordAssistantMessage,
  findSessionFile,
  listSessions,
  replaySessionHistory,
  SessionHistoryEntry,
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

  describe("encodeProjectPath", () => {
    it("removes leading slash and replaces separators", () => {
      expect(encodeProjectPath("/Users/test/project")).toBe(
        "Users-test-project",
      );
    });

    it("handles Windows-style colons", () => {
      expect(encodeProjectPath("C:/Users/test")).toBe("C--Users-test");
    });

    it("handles paths without leading slash", () => {
      expect(encodeProjectPath("relative/path")).toBe("relative-path");
    });
  });

  describe("sessionFilePath", () => {
    it("builds correct path", () => {
      const result = sessionFilePath("/Users/test/project", "session-123");
      expect(result).toContain("sessions");
      expect(result).toContain("Users-test-project");
      expect(result).toContain("session-123.jsonl");
    });
  });

  describe("ensureSessionDir", () => {
    it("creates directory if it does not exist", async () => {
      const dir = await ensureSessionDir("/Users/test/project");
      expect(fs.existsSync(dir)).toBe(true);
      expect(dir).toContain("Users-test-project");
    });
  });

  describe("appendSessionEntry", () => {
    it("appends entry to session file", async () => {
      const cwd = "/Users/test/project";
      const sessionId = "test-session";
      const entry: SessionHistoryEntry = {
        type: "user",
        timestamp: "2024-01-01T00:00:00.000Z",
        sessionId,
        cwd,
        message: { role: "user", content: "Hello" },
      };

      await appendSessionEntry(cwd, sessionId, entry);

      const filePath = sessionFilePath(cwd, sessionId);
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(content.trim());
      expect(parsed.type).toBe("user");
      expect(parsed.message.content).toBe("Hello");
    });

    it("appends multiple entries", async () => {
      const cwd = "/Users/test/project";
      const sessionId = "test-session";

      await appendSessionEntry(cwd, sessionId, {
        type: "user",
        timestamp: "2024-01-01T00:00:00.000Z",
        sessionId,
        message: { role: "user", content: "First" },
      });

      await appendSessionEntry(cwd, sessionId, {
        type: "assistant",
        timestamp: "2024-01-01T00:00:01.000Z",
        sessionId,
        message: { role: "assistant", content: "Second" },
      });

      const filePath = sessionFilePath(cwd, sessionId);
      const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(2);
    });
  });

  describe("recordUserMessage", () => {
    it("records user message with correct structure", async () => {
      const cwd = "/Users/test/project";
      const sessionId = "test-session";

      await recordUserMessage(cwd, sessionId, "Hello world");

      const filePath = sessionFilePath(cwd, sessionId);
      const content = fs.readFileSync(filePath, "utf-8");
      const entry = JSON.parse(content.trim());

      expect(entry.type).toBe("user");
      expect(entry.sessionId).toBe(sessionId);
      expect(entry.message.role).toBe("user");
      expect(entry.message.content).toBe("Hello world");
      expect(entry.timestamp).toBeDefined();
    });
  });

  describe("recordAssistantMessage", () => {
    it("records assistant message with correct structure", async () => {
      const cwd = "/Users/test/project";
      const sessionId = "test-session";

      await recordAssistantMessage(cwd, sessionId, "I can help with that");

      const filePath = sessionFilePath(cwd, sessionId);
      const content = fs.readFileSync(filePath, "utf-8");
      const entry = JSON.parse(content.trim());

      expect(entry.type).toBe("assistant");
      expect(entry.sessionId).toBe(sessionId);
      expect(entry.message.role).toBe("assistant");
      expect(entry.message.content).toBe("I can help with that");
    });
  });

  describe("findSessionFile", () => {
    it("finds session file in expected location", async () => {
      const cwd = "/Users/test/project";
      const sessionId = "test-session";

      await recordUserMessage(cwd, sessionId, "Hello");

      const found = await findSessionFile(sessionId, cwd);
      expect(found).not.toBeNull();
      expect(found).toContain(sessionId);
    });

    it("returns null for non-existent session", async () => {
      const found = await findSessionFile("non-existent", "/Users/test");
      expect(found).toBeNull();
    });

    it("finds session file in different project directory", async () => {
      const originalCwd = "/Users/test/original";
      const sessionId = "test-session";

      await recordUserMessage(originalCwd, sessionId, "Hello");

      // Search from different cwd
      const found = await findSessionFile(sessionId, "/Users/test/other");
      expect(found).not.toBeNull();
    });
  });

  describe("listSessions", () => {
    it("returns empty array when no sessions exist", async () => {
      const sessions = await listSessions();
      expect(sessions).toEqual([]);
    });

    it("lists sessions with metadata", async () => {
      const cwd = "/Users/test/project";
      const sessionId = "test-session";

      await recordUserMessage(cwd, sessionId, "Hello world");
      await recordAssistantMessage(cwd, sessionId, "Hi there");

      const sessions = await listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe(sessionId);
      expect(sessions[0].title).toBe("Hello world");
      expect(sessions[0].updatedAt).toBeDefined();
    });

    it("filters sessions by cwd", async () => {
      const cwd1 = "/Users/test/project1";
      const cwd2 = "/Users/test/project2";

      await recordUserMessage(cwd1, "session-1", "First project");
      await recordUserMessage(cwd2, "session-2", "Second project");

      const filtered = await listSessions(cwd1);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].sessionId).toBe("session-1");
    });

    it("sorts sessions by updatedAt descending", async () => {
      const cwd = "/Users/test/project";

      await recordUserMessage(cwd, "session-old", "Old session");
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 10));
      await recordUserMessage(cwd, "session-new", "New session");

      const sessions = await listSessions();
      expect(sessions[0].sessionId).toBe("session-new");
      expect(sessions[1].sessionId).toBe("session-old");
    });

    it("skips sessions without conversation messages", async () => {
      const cwd = "/Users/test/project";
      const sessionId = "metadata-only";
      const filePath = sessionFilePath(cwd, sessionId);

      await ensureSessionDir(cwd);
      fs.writeFileSync(
        filePath,
        `${JSON.stringify({
          type: "session_meta",
          timestamp: new Date().toISOString(),
          sessionId,
          cwd,
          backendSessionId: "backend-1",
        })}\n`,
      );

      const sessions = await listSessions();
      expect(sessions).toHaveLength(0);
    });

    it("falls back to the first assistant message when user text is missing", async () => {
      const cwd = "/Users/test/project";
      const sessionId = "assistant-title";

      await appendSessionEntry(cwd, sessionId, {
        type: "assistant",
        timestamp: new Date().toISOString(),
        sessionId,
        cwd,
        message: {
          role: "assistant",
          content: "Initial assistant message",
        },
      });

      const sessions = await listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].title).toBe("Initial assistant message");
    });

    it("extracts title from array content in the first user message", async () => {
      const cwd = "/Users/test/project";
      const sessionId = "array-title";

      await appendSessionEntry(cwd, sessionId, {
        type: "user",
        timestamp: new Date().toISOString(),
        sessionId,
        cwd,
        message: {
          role: "user",
          content: [{ type: "text", text: "Fix login bug" }],
        },
      });

      const sessions = await listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].title).toBe("Fix login bug");
    });

    it("filters by exact cwd using per-entry metadata", async () => {
      const sharedEncodedPath = encodeProjectPath("/Users/test/a-b");
      const projectDir = path.join(tempDir, "sessions", sharedEncodedPath);
      fs.mkdirSync(projectDir, { recursive: true });

      fs.writeFileSync(
        path.join(projectDir, "sess-a-b.jsonl"),
        [
          JSON.stringify({ type: "init", sessionId: "sess-a-b" }),
          JSON.stringify({
            type: "user",
            sessionId: "sess-a-b",
            cwd: "/Users/test/a-b",
            message: { content: "A-B" },
          }),
        ].join("\n"),
      );

      fs.writeFileSync(
        path.join(projectDir, "sess-a-slash-b.jsonl"),
        [
          JSON.stringify({ type: "init", sessionId: "sess-a-slash-b" }),
          JSON.stringify({
            type: "user",
            sessionId: "sess-a-slash-b",
            cwd: "/Users/test/a/b",
            message: { content: "A/B" },
          }),
        ].join("\n"),
      );

      const sessions = await listSessions("/Users/test/a-b");
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe("sess-a-b");
      expect(sessions[0].cwd).toBe("/Users/test/a-b");
    });
  });

  describe("replaySessionHistory", () => {
    it("emits notifications for user and assistant messages", async () => {
      const cwd = "/Users/test/project";
      const sessionId = "test-session";

      await recordUserMessage(cwd, sessionId, "Hello");
      await recordAssistantMessage(cwd, sessionId, "Hi there");

      const notifications: SessionNotification[] = [];
      const filePath = sessionFilePath(cwd, sessionId);

      await replaySessionHistory({
        sessionId,
        filePath,
        sendNotification: async (notification) => {
          notifications.push(notification);
        },
      });

      expect(notifications).toHaveLength(2);
      expect(notifications[0].update.sessionUpdate).toBe("user_message_chunk");
      expect(notifications[1].update.sessionUpdate).toBe("agent_message_chunk");
    });

    it("skips entries with mismatched sessionId", async () => {
      const cwd = "/Users/test/project";
      const sessionId = "test-session";

      // Write entry with different sessionId
      await appendSessionEntry(cwd, sessionId, {
        type: "user",
        timestamp: new Date().toISOString(),
        sessionId: "other-session",
        message: { role: "user", content: "Should be skipped" },
      });

      await appendSessionEntry(cwd, sessionId, {
        type: "user",
        timestamp: new Date().toISOString(),
        sessionId,
        message: { role: "user", content: "Should be included" },
      });

      const notifications: SessionNotification[] = [];
      const filePath = sessionFilePath(cwd, sessionId);

      await replaySessionHistory({
        sessionId,
        filePath,
        sendNotification: async (notification) => {
          notifications.push(notification);
        },
      });

      expect(notifications).toHaveLength(1);
    });

    it("handles array content in messages", async () => {
      const cwd = "/Users/test/project";
      const sessionId = "test-session";

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
      const filePath = sessionFilePath(cwd, sessionId);

      await replaySessionHistory({
        sessionId,
        filePath,
        sendNotification: async (notification) => {
          notifications.push(notification);
        },
      });

      expect(notifications).toHaveLength(1);
      const update = notifications[0].update as any;
      expect(update.content.text).toBe("Part 1Part 2");
    });
  });
});
