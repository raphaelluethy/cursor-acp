import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import { SessionInfo, SessionNotification } from "@agentclientprotocol/sdk";

const NO_TITLE_PLACEHOLDER = "[no title]";

export function getCursorAcpConfigDir(): string {
	return process.env.CURSOR_ACP_CONFIG_DIR ?? path.join(os.homedir(), ".cursor-acp");
}

export interface SessionHistoryEntry {
	type: "user" | "assistant";
	timestamp: string;
	sessionId: string;
	cwd?: string;
	message: {
		role: "user" | "assistant";
		content: string | unknown[];
	};
}

export interface SessionMetaEntry {
	type: "session_meta";
	timestamp: string;
	sessionId: string;
	cwd: string;
	backendSessionId?: string;
}

interface SessionListEntry {
	type?: string;
	sessionId?: string;
	cwd?: string;
	isSidechain?: boolean;
	message?: {
		content?: unknown;
	};
}

/**
 * Encode a project path for use as a directory name.
 * Replaces path separators with hyphens and removes leading slashes.
 */
export function encodeProjectPath(projectPath: string): string {
	return projectPath.replace(/^\//, "").replace(/\//g, "-").replace(/:/g, "-");
}

/**
 * Build the full path to a session file.
 */
export function sessionFilePath(cwd: string, sessionId: string): string {
	const encodedPath = encodeProjectPath(cwd);
	return path.join(getCursorAcpConfigDir(), "sessions", encodedPath, `${sessionId}.jsonl`);
}

/**
 * Ensure the session directory exists and return the file path.
 */
export async function ensureSessionDir(cwd: string): Promise<string> {
	const encodedPath = encodeProjectPath(cwd);
	const dir = path.join(getCursorAcpConfigDir(), "sessions", encodedPath);
	await fs.promises.mkdir(dir, { recursive: true });
	return dir;
}

/**
 * Append a history entry to the session file.
 */
export async function appendSessionEntry(
	cwd: string,
	sessionId: string,
	entry: SessionHistoryEntry,
): Promise<void> {
	await ensureSessionDir(cwd);
	const filePath = sessionFilePath(cwd, sessionId);
	const line = JSON.stringify(entry) + "\n";
	await fs.promises.appendFile(filePath, line, "utf-8");
}

/**
 * Record session metadata (e.g. backendSessionId) to the session file.
 */
export async function recordSessionMeta(
	cwd: string,
	sessionId: string,
	backendSessionId: string | undefined,
): Promise<void> {
	const entry: SessionMetaEntry = {
		type: "session_meta",
		timestamp: new Date().toISOString(),
		sessionId,
		cwd,
		backendSessionId,
	};
	await ensureSessionDir(cwd);
	const filePath = sessionFilePath(cwd, sessionId);
	const line = JSON.stringify(entry) + "\n";
	await fs.promises.appendFile(filePath, line, "utf-8");
}

/**
 * Read session metadata from the session file, returning the backendSessionId if stored.
 */
export async function readSessionMeta(filePath: string): Promise<{ backendSessionId?: string }> {
	try {
		const content = await fs.promises.readFile(filePath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type === "session_meta" && entry.backendSessionId) {
					return { backendSessionId: entry.backendSessionId };
				}
			} catch {
				continue;
			}
		}
	} catch {
		// file not readable
	}
	return {};
}

/**
 * Record a user message to the session history.
 */
export async function recordUserMessage(
	cwd: string,
	sessionId: string,
	content: string,
): Promise<void> {
	const entry: SessionHistoryEntry = {
		type: "user",
		timestamp: new Date().toISOString(),
		sessionId,
		cwd,
		message: {
			role: "user",
			content,
		},
	};
	await appendSessionEntry(cwd, sessionId, entry);
}

/**
 * Record an assistant message to the session history.
 */
export async function recordAssistantMessage(
	cwd: string,
	sessionId: string,
	content: string | unknown[],
): Promise<void> {
	const entry: SessionHistoryEntry = {
		type: "assistant",
		timestamp: new Date().toISOString(),
		sessionId,
		cwd,
		message: {
			role: "assistant",
			content,
		},
	};
	await appendSessionEntry(cwd, sessionId, entry);
}

/**
 * Find a session file by ID, first checking the given cwd's project directory,
 * then falling back to scanning all project directories.
 */
export async function findSessionFile(sessionId: string, cwd: string): Promise<string | null> {
	const fileName = `${sessionId}.jsonl`;

	// Fast path: check the expected location based on cwd
	const expectedPath = sessionFilePath(cwd, sessionId);
	try {
		await fs.promises.access(expectedPath);
		return expectedPath;
	} catch {
		// Not found at expected path, scan all project directories
	}

	const sessionsDir = path.join(getCursorAcpConfigDir(), "sessions");
	try {
		const projectDirs = await fs.promises.readdir(sessionsDir);
		for (const encodedPath of projectDirs) {
			const projectDir = path.join(sessionsDir, encodedPath);
			const stat = await fs.promises.stat(projectDir);
			if (!stat.isDirectory()) {
				continue;
			}

			const candidatePath = path.join(projectDir, fileName);
			try {
				await fs.promises.access(candidatePath);
				return candidatePath;
			} catch {
				continue;
			}
		}
	} catch {
		// sessions directory doesn't exist or isn't readable
	}

	return null;
}

/**
 * Sanitize a title by truncating and cleaning up whitespace.
 */
function sanitizeTitle(text: string): string {
	const MAX_TITLE_LENGTH = 128;
	const sanitized = text
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (sanitized.length <= MAX_TITLE_LENGTH) {
		return sanitized;
	}
	return sanitized.slice(0, MAX_TITLE_LENGTH - 3) + "...";
}

function extractTitleFromContent(content: unknown): string | undefined {
	if (typeof content === "string") {
		return sanitizeTitle(content);
	}

	if (!Array.isArray(content) || content.length === 0) {
		return undefined;
	}

	const first = content[0];
	if (typeof first === "string") {
		return sanitizeTitle(first);
	}

	if (
		typeof first === "object" &&
		first !== null &&
		"text" in first &&
		typeof (first as { text: unknown }).text === "string"
	) {
		return sanitizeTitle((first as { text: string }).text);
	}

	return undefined;
}

/**
 * List all sessions, optionally filtered by cwd.
 */
export async function listSessions(cwd?: string): Promise<SessionInfo[]> {
	const sessionsDir = path.join(getCursorAcpConfigDir(), "sessions");

	try {
		await fs.promises.access(sessionsDir);
	} catch {
		return [];
	}

	const allSessions: SessionInfo[] = [];
	const encodedCwdFilter = cwd ? encodeProjectPath(cwd) : null;

	try {
		const projectDirs = await fs.promises.readdir(sessionsDir);

		for (const encodedPath of projectDirs) {
			const projectDir = path.join(sessionsDir, encodedPath);
			const stat = await fs.promises.stat(projectDir);
			if (!stat.isDirectory()) {
				continue;
			}

			if (encodedCwdFilter && encodedPath !== encodedCwdFilter) {
				continue;
			}

			const files = await fs.promises.readdir(projectDir);
			const jsonlFiles = files.filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"));

			for (const file of jsonlFiles) {
				const filePath = path.join(projectDir, file);
				try {
					const content = await fs.promises.readFile(filePath, "utf-8");
					const lines = content.trim().split("\n").filter(Boolean);

					const sessionId = file.replace(".jsonl", "");
					let parsedAnyEntry = false;
					let hasConversationEntry = false;
					let userTitle: string | undefined;
					let conversationTitle: string | undefined;
					let sessionCwd: string | undefined;

					for (const line of lines) {
						try {
							const entry = JSON.parse(line) as SessionListEntry;
							parsedAnyEntry = true;

							if (entry.isSidechain === true) {
								continue;
							}

							if (
								typeof entry.sessionId === "string" &&
								entry.sessionId !== sessionId
							) {
								continue;
							}

							if (typeof entry.cwd === "string") {
								sessionCwd = entry.cwd;
							}

							if (
								!conversationTitle &&
								(entry.type === "user" || entry.type === "assistant")
							) {
								hasConversationEntry = true;
								conversationTitle = extractTitleFromContent(entry.message?.content);
							}

							if (!userTitle && entry.type === "user") {
								userTitle = extractTitleFromContent(entry.message?.content);
							}

							// Keep scanning until both values are discovered, since cwd can
							// appear in later entries after the first user message.
							if (userTitle && sessionCwd) {
								break;
							}
						} catch {
							continue;
						}
					}

					if (!parsedAnyEntry) {
						continue;
					}

					if (!sessionCwd) {
						continue;
					}

					if (!hasConversationEntry) {
						continue;
					}

					if (cwd && sessionCwd !== cwd) {
						continue;
					}

					const fileStat = await fs.promises.stat(filePath);
					const updatedAt = fileStat.mtime.toISOString();

					allSessions.push({
						sessionId,
						cwd: sessionCwd,
						title: userTitle ?? conversationTitle ?? NO_TITLE_PLACEHOLDER,
						updatedAt,
					});
				} catch {
					continue;
				}
			}
		}
	} catch {
		return [];
	}

	// Sort by updatedAt descending (most recent first)
	allSessions.sort((a, b) => {
		const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
		const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
		return timeB - timeA;
	});

	return allSessions;
}

export interface ReplayOptions {
	sessionId: string;
	filePath: string;
	sendNotification: (notification: SessionNotification) => Promise<void>;
}

/**
 * Replay session history by reading the JSONL file and emitting ACP notifications.
 */
export async function replaySessionHistory(options: ReplayOptions): Promise<void> {
	const { sessionId, filePath, sendNotification } = options;

	const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
	const reader = readline.createInterface({
		input: stream,
		crlfDelay: Infinity,
	});

	try {
		for await (const line of reader) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}

			let entry: SessionHistoryEntry;
			try {
				entry = JSON.parse(trimmed) as SessionHistoryEntry;
			} catch {
				continue;
			}

			if (entry.type !== "user" && entry.type !== "assistant") {
				continue;
			}

			if (entry.sessionId && entry.sessionId !== sessionId) {
				continue;
			}

			const message = entry.message;
			if (!message) {
				continue;
			}

			const role = message.role;
			if (role !== "user" && role !== "assistant") {
				continue;
			}

			const content = message.content;
			if (typeof content !== "string" && !Array.isArray(content)) {
				continue;
			}

			const textContent =
				typeof content === "string"
					? content
					: content
							.map((item) => {
								if (typeof item === "string") {
									return item;
								}
								if (
									typeof item === "object" &&
									item !== null &&
									"text" in item &&
									typeof (item as { text: unknown }).text === "string"
								) {
									return (item as { text: string }).text;
								}
								return "";
							})
							.join("");

			if (role === "user") {
				await sendNotification({
					sessionId,
					update: {
						sessionUpdate: "user_message_chunk",
						content: {
							type: "text",
							text: textContent,
						},
					},
				});
			} else {
				await sendNotification({
					sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: {
							type: "text",
							text: textContent,
						},
					},
				});
			}
		}
	} finally {
		reader.close();
	}
}
