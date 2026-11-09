import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { encodeProjectPath, readSessionMeta } from "../session-storage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const DIST_ENTRY = path.resolve(PROJECT_ROOT, "dist/index.js");

export interface AcpChildClient {
	pid: number;
	sendRequest<T = unknown>(method: string, params: Record<string, unknown>): Promise<T>;
	sendPrompt(sessionId: string, promptText: string): Promise<{ reply: string; result: unknown }>;
	waitForReplayedHistory(timeoutMs?: number): Promise<string[]>;
	getToolCallsAttempted(): number;
	getStderr(): string;
	kill(signal?: NodeJS.Signals): Promise<{ exitCode: number | null; signal: string | null }>;
}

export interface RunHarnessOptions {
	recoveryMethod: "session/load" | "session/resume";
	logFile?: string;
	onLog?: (line: string) => void;
}

export interface RunHarnessResult {
	recoveryMethod: "session/load" | "session/resume";
	acpSessionId: string;
	firstPid: number;
	firstExitSignal: string | null;
	secondPid: number;
	firstBackendSessionId?: string;
	secondBackendSessionId?: string;
	replayedHistory: string;
	turn1Reply: string;
	turn2Reply: string;
	toolCallsAttempted: number;
	replayLeakedIntoTurn2: boolean;
	error?: string;
	tokenRetained: boolean;
	backendSessionIdRetained: boolean;
	passed: boolean;
}

export function spawnAcpChild(cwd: string, configDir: string): AcpChildClient {
	const child: ChildProcess = spawn(process.execPath, [DIST_ENTRY], {
		cwd,
		env: {
			...process.env,
			CURSOR_ACP_CONFIG_DIR: configDir,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});

	if (!child.pid) {
		throw new Error("Failed to spawn cursor-acp child process");
	}

	const pid = child.pid;
	let nextReqId = 0;
	const pendingRequests = new Map<
		number | string,
		{ method: string; resolve: (val: unknown) => void; reject: (err: Error) => void }
	>();

	let toolCallsAttempted = 0;
	let stderrBuffer = "";
	const replayedChunks: string[] = [];
	let replayListener: ((chunk: string) => void) | null = null;
	let activePrompt: { chunks: string[] } | null = null;

	// Consume stderr to avoid blocking the child process on full buffer
	child.stderr?.on("data", (chunk: Buffer | string) => {
		stderrBuffer += chunk.toString();
	});

	// Handle child process error
	child.on("error", (err) => {
		for (const [, req] of pendingRequests) {
			req.reject(new Error(`Child process error: ${err.message} (method=${req.method})`));
		}
		pendingRequests.clear();
	});

	// Handle unexpected process exit
	child.on("close", (code, signal) => {
		for (const [, req] of pendingRequests) {
			req.reject(
				new Error(
					`Child process exited unexpectedly with code ${code}, signal ${signal} (method=${req.method})`,
				),
			);
		}
		pendingRequests.clear();
	});

	const rl = readline.createInterface({
		input: child.stdout!,
		crlfDelay: Infinity,
	});

	rl.on("line", (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		try {
			const msg = JSON.parse(trimmed) as {
				id?: number | string;
				result?: unknown;
				error?: { code: number; message: string; data?: unknown };
				method?: string;
				params?: Record<string, unknown>;
			};

			if (msg.id !== undefined && pendingRequests.has(msg.id)) {
				const req = pendingRequests.get(msg.id)!;
				pendingRequests.delete(msg.id);
				if (msg.error) {
					const err = new Error(msg.error.message || `RPC Error ${msg.error.code}`);
					(err as unknown as { rpcError: unknown }).rpcError = msg.error;
					req.reject(err);
				} else {
					req.resolve(msg.result);
				}
				return;
			}

			// Inbound request from server to client
			if (msg.id !== undefined && msg.method) {
				if (msg.method === "session/request_permission") {
					// In ask (no-tools) mode, any tool call request is an unauthorized attempt
					toolCallsAttempted++;
					child.stdin?.write(
						JSON.stringify({
							jsonrpc: "2.0",
							id: msg.id,
							error: { code: -32600, message: "Tools are disabled in ask mode" },
						}) + "\n",
					);
				} else {
					child.stdin?.write(
						JSON.stringify({
							jsonrpc: "2.0",
							id: msg.id,
							result: {},
						}) + "\n",
					);
				}
				return;
			}

			// Inbound notification
			if (msg.method === "session/update" && msg.params?.update) {
				const update = msg.params.update as {
					sessionUpdate?: string;
					content?: { type: string; text: string };
				};
				if (
					update.sessionUpdate === "agent_message_chunk" &&
					update.content?.type === "text" &&
					typeof update.content.text === "string"
				) {
					const text = update.content.text;
					if (activePrompt) {
						activePrompt.chunks.push(text);
					} else {
						replayedChunks.push(text);
						replayListener?.(text);
					}
				}
			}
		} catch {
			// ignore parse errors
		}
	});

	function sendRequest<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const id = ++nextReqId;
			const timeout = setTimeout(() => {
				if (pendingRequests.has(id)) {
					pendingRequests.delete(id);
					reject(new Error(`ACP request timed out: method=${method} id=${id}`));
				}
			}, 60000);

			pendingRequests.set(id, {
				method,
				resolve: (res) => {
					clearTimeout(timeout);
					resolve(res as T);
				},
				reject: (err) => {
					clearTimeout(timeout);
					reject(err);
				},
			});

			const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
			child.stdin?.write(payload);
		});
	}

	async function sendPrompt(
		sessionId: string,
		promptText: string,
	): Promise<{ reply: string; result: unknown }> {
		const promptTracker = { chunks: [] as string[] };
		activePrompt = promptTracker;
		try {
			const result = await sendRequest("session/prompt", {
				sessionId,
				prompt: [
					{
						type: "text",
						text: promptText,
					},
				],
			});
			return {
				reply: promptTracker.chunks.join(""),
				result,
			};
		} finally {
			activePrompt = null;
		}
	}

	function waitForReplayedHistory(
		timeoutMs: number = 3000,
		idleMs: number = 150,
	): Promise<string[]> {
		return new Promise<string[]>((resolve) => {
			let idleTimer: NodeJS.Timeout | null = null;
			let maxTimer: NodeJS.Timeout | null = null;

			const finish = () => {
				if (idleTimer) clearTimeout(idleTimer);
				if (maxTimer) clearTimeout(maxTimer);
				replayListener = null;
				resolve([...replayedChunks]);
			};

			if (replayedChunks.length > 0) {
				idleTimer = setTimeout(finish, idleMs);
			}

			replayListener = () => {
				if (idleTimer) clearTimeout(idleTimer);
				idleTimer = setTimeout(finish, idleMs);
			};

			maxTimer = setTimeout(finish, timeoutMs);
		});
	}

	return {
		pid,
		sendRequest,
		sendPrompt,
		waitForReplayedHistory,
		getToolCallsAttempted(): number {
			return toolCallsAttempted;
		},
		getStderr(): string {
			return stderrBuffer;
		},
		kill(
			signal: NodeJS.Signals = "SIGKILL",
		): Promise<{ exitCode: number | null; signal: string | null }> {
			return new Promise((resolve) => {
				if (child.exitCode !== null || child.signalCode !== null) {
					resolve({ exitCode: child.exitCode, signal: child.signalCode });
					return;
				}
				child.once("exit", (code, sig) => {
					resolve({ exitCode: code, signal: sig });
				});
				child.kill(signal);
			});
		},
	};
}

function getSessionFilePath(configDir: string, cwd: string, sessionId: string): string {
	const encodedPath = encodeProjectPath(cwd);
	return path.join(configDir, "sessions", encodedPath, `${sessionId}.jsonl`);
}

export async function runSessionResumeE2E(options: RunHarnessOptions): Promise<RunHarnessResult> {
	const tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-acp-e2e-ws-"));
	const tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-acp-e2e-cfg-"));

	const token = `PASS_${randomBytes(8).toString("hex")}`;
	const sanitize = (text: string): string => {
		return text
			.split(token)
			.join("[REDACTED_TOKEN]")
			.split(tempWorkspace)
			.join("[REDACTED_WORKSPACE]")
			.split(tempConfigDir)
			.join("[REDACTED_CONFIG_DIR]");
	};

	const logLines: string[] = [];
	const log = (msg: string) => {
		const line = `[${new Date().toISOString()}] ${sanitize(msg)}`;
		logLines.push(line);
		options.onLog?.(line);
	};

	let client1: AcpChildClient | undefined;
	let client2: AcpChildClient | undefined;
	let acpSessionId = "";
	let firstPid = 0;
	let secondPid = 0;
	let firstExitSignal: string | null = null;
	let firstBackendSessionId: string | undefined;
	let secondBackendSessionId: string | undefined;
	let turn1Reply = "";
	let turn2Reply = "";
	let replayedHistory = "";
	let failureError: string | undefined;

	try {
		log(`=== Starting Session Resume E2E for ${options.recoveryMethod} ===`);
		log(`Target model: composer-2.5, fast: false, mode: ask`);

		// Step 1: Start child 1
		client1 = spawnAcpChild(tempWorkspace, tempConfigDir);
		firstPid = client1.pid;
		log(`Spawned child 1 (PID: ${firstPid})`);

		// Initialize child 1
		await client1.sendRequest("initialize", {
			protocolVersion: 1,
			clientCapabilities: {},
		});

		// Create session
		const newSessionRes = await client1.sendRequest<{ sessionId: string }>("session/new", {
			cwd: tempWorkspace,
			mcpServers: [],
		});
		acpSessionId = newSessionRes.sessionId;
		log(`Session created: acpSessionId=${acpSessionId}`);

		// Explicitly configure mode and model options in order:
		// 1. mode -> ask
		await client1.sendRequest("session/set_mode", {
			sessionId: acpSessionId,
			modeId: "ask",
		});
		log(`Session mode set to ask`);

		// 2. model -> composer-2.5
		await client1.sendRequest("session/set_config_option", {
			sessionId: acpSessionId,
			configId: "model",
			value: "composer-2.5",
		});
		log(`Session model set to composer-2.5`);

		// 3. fast -> false
		await client1.sendRequest("session/set_config_option", {
			sessionId: acpSessionId,
			configId: "fast",
			value: "false",
		});
		log(`Session fast parameter set to false`);

		// Turn 1 prompt
		log(`Sending Turn 1 prompt with secret token`);
		const turn1Res = await client1.sendPrompt(
			acpSessionId,
			`请牢记以下口令，稍后我会向你询问：${token}。现在请只回复一个单词“ACK”，不要输出其他任何内容。`,
		);
		turn1Reply = turn1Res.reply.trim();
		log(`Turn 1 prompt completed. Model reply: ${turn1Reply}`);

		// Verify backend session ID on disk
		const metaPath = getSessionFilePath(tempConfigDir, tempWorkspace, acpSessionId);
		const metaBefore = await readSessionMeta(metaPath);
		firstBackendSessionId = metaBefore.backendSessionId;
		log(`Turn 1 persisted backendSessionId: ${firstBackendSessionId}`);

		if (!firstBackendSessionId || !firstBackendSessionId.startsWith("agent-")) {
			throw new Error(
				`Turn 1 failed to establish real SDK agent session. backendSessionId=${firstBackendSessionId}. Auth/Network failure is not a valid RED!`,
			);
		}

		// Step 2: Kill child 1 with SIGKILL
		log(`Killing child 1 (PID: ${firstPid}) with SIGKILL...`);
		const killResult = await client1.kill("SIGKILL");
		firstExitSignal = killResult.signal;
		log(`Child 1 exited with signal: ${firstExitSignal}`);

		// Step 3: Spawn child 2
		client2 = spawnAcpChild(tempWorkspace, tempConfigDir);
		secondPid = client2.pid;
		log(`Spawned child 2 (PID: ${secondPid}) with same workspace and config dir`);

		// Initialize child 2
		await client2.sendRequest("initialize", {
			protocolVersion: 1,
			clientCapabilities: {},
		});

		// Step 4: Resume session using target recovery method
		log(`Calling recovery method: ${options.recoveryMethod}`);
		if (options.recoveryMethod === "session/load") {
			await client2.sendRequest("session/load", {
				sessionId: acpSessionId,
				cwd: tempWorkspace,
				mcpServers: [],
			});
		} else {
			await client2.sendRequest("session/resume", {
				sessionId: acpSessionId,
				cwd: tempWorkspace,
			});
		}
		log(`Recovery request succeeded`);

		// Await and drain replayed history from recovery before sending Turn 2
		const replayed = await client2.waitForReplayedHistory(2000);
		replayedHistory = replayed.join("");
		if (replayedHistory) {
			log(
				`Replayed conversation history received (${replayedHistory.length} chars): ${replayedHistory}`,
			);
		}

		// Step 5: Turn 2 prompt
		log(`Sending Turn 2 prompt: asking for the remembered token`);
		const turn2Res = await client2.sendPrompt(
			acpSessionId,
			"之前让你记住的口令是什么？只输出口令",
		);
		turn2Reply = turn2Res.reply.trim();
		log(`Turn 2 prompt completed. Model reply: ${turn2Reply}`);

		// Verify backend session ID on disk after Turn 2
		const metaAfter = await readSessionMeta(metaPath);
		secondBackendSessionId = metaAfter.backendSessionId;
		log(`Turn 2 persisted backendSessionId: ${secondBackendSessionId}`);
	} catch (err: unknown) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		failureError = errorMessage;
		log(`FAILURE: ${errorMessage}`);
	} finally {
		if (client1) {
			await client1.kill("SIGKILL").catch(() => undefined);
		}
		if (client2) {
			await client2.kill("SIGKILL").catch(() => undefined);
		}
		await fs.rm(tempWorkspace, { recursive: true, force: true }).catch(() => undefined);
		await fs.rm(tempConfigDir, { recursive: true, force: true }).catch(() => undefined);
	}

	const toolCallsAttempted =
		(client1?.getToolCallsAttempted() ?? 0) + (client2?.getToolCallsAttempted() ?? 0);
	const tokenRetained = turn2Reply.includes(token);
	const replayLeakedIntoTurn2 = turn2Reply.includes("ACK");
	const backendSessionIdRetained =
		Boolean(firstBackendSessionId) && firstBackendSessionId === secondBackendSessionId;
	const passed =
		!failureError &&
		tokenRetained &&
		!replayLeakedIntoTurn2 &&
		backendSessionIdRetained &&
		toolCallsAttempted === 0;

	log(`Summary for ${options.recoveryMethod}:`);
	log(
		`  backendSessionIdRetained: ${backendSessionIdRetained} (${firstBackendSessionId} -> ${secondBackendSessionId})`,
	);
	log(`  tokenRetained: ${tokenRetained} (reply: "${turn2Reply}")`);
	log(`  replayLeakedIntoTurn2: ${replayLeakedIntoTurn2}`);
	log(`  toolCallsAttempted: ${toolCallsAttempted}`);
	log(`  passed: ${passed}`);
	if (failureError) {
		log(`  error: ${failureError}`);
	}

	// Write sanitized log file if requested
	if (options.logFile) {
		await fs.mkdir(path.dirname(options.logFile), { recursive: true });
		await fs.writeFile(options.logFile, logLines.join("\n") + "\n", "utf-8");
	}

	return {
		recoveryMethod: options.recoveryMethod,
		acpSessionId,
		firstPid,
		firstExitSignal,
		secondPid,
		firstBackendSessionId,
		secondBackendSessionId,
		replayedHistory,
		turn1Reply,
		turn2Reply,
		toolCallsAttempted,
		replayLeakedIntoTurn2,
		error: failureError,
		tokenRetained,
		backendSessionIdRetained,
		passed,
	};
}
