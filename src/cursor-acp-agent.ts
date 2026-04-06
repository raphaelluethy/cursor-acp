import {
	Agent,
	AgentSideConnection,
	AuthenticateRequest,
	AvailableCommand,
	CancelNotification,
	ClientCapabilities,
	ForkSessionRequest,
	ForkSessionResponse,
	InitializeRequest,
	InitializeResponse,
	ListSessionsRequest,
	ListSessionsResponse,
	NewSessionRequest,
	NewSessionResponse,
	PromptRequest,
	PromptResponse,
	ReadTextFileRequest,
	ReadTextFileResponse,
	RequestError,
	RequestPermissionRequest,
	RequestPermissionResponse,
	ResumeSessionRequest,
	ResumeSessionResponse,
	SetSessionModelRequest,
	SetSessionModelResponse,
	SetSessionModeRequest,
	SetSessionModeResponse,
	SessionNotification,
	ToolCallContent,
	WriteTextFileRequest,
	WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import packageJson from "../package.json" with { type: "json" };
import { CursorAuth, CursorAuthClient } from "./auth.js";
import { CachedToolUse, mapCursorEventToAcp, RejectedToolCall } from "./cursor-event-mapper.js";
import {
	CreateNativeSessionOptions,
	CursorNativeAcpClient,
	NativeModeId,
	NativeSessionBackend,
	NativeSessionCallbacks,
} from "./cursor-native-acp-client.js";
import { CursorCliRunner } from "./cursor-cli-runner.js";
import { normalizeModelId, resolveModelId } from "./model-id.js";
import { parseLeadingSlashCommand, promptToCursorText } from "./prompt-conversion.js";
import {
	availableSlashCommands,
	CursorModelDescriptor,
	handleSlashCommand,
	normalizeSlashCommandName,
} from "./slash-commands.js";
import { availableModes, DEFAULT_MODE_ID, normalizeModeId, SessionModeId } from "./settings.js";
import {
	findSessionFile,
	getCursorAcpConfigDir,
	listSessions,
	readSessionMeta,
	recordAssistantMessage,
	recordSessionMeta,
	recordUserMessage,
	replaySessionHistory,
} from "./session-storage.js";
import {
	appendAssistantTextFromNativeChunk,
	formatTurnRecapMarkdown,
	recordTurnArtifactsFromNativeSessionUpdate,
	type TurnArtifact,
} from "./native-assistant-stream.js";
import { Logger, unreachable } from "./utils.js";
import * as fs from "node:fs";
import * as path from "node:path";

function markdownEscape(text: string): string {
	let fence = "```";
	for (const [m] of text.matchAll(/^```+/gm)) {
		while (m.length >= fence.length) {
			fence += "`";
		}
	}
	return `${fence}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
}

function plainTextContent(text: string): ToolCallContent[] {
	return [
		{
			type: "content",
			content: {
				type: "text",
				text,
			},
		},
	];
}

function summarizeExecuteToolCall(update: Record<string, any>): ToolCallContent[] | undefined {
	const rawInput = update.rawInput;
	if (!rawInput || typeof rawInput !== "object") {
		return undefined;
	}
	const command = typeof rawInput.command === "string" ? rawInput.command : "";
	if (!command) {
		return undefined;
	}
	const description = typeof rawInput.description === "string" ? rawInput.description : "";
	const cwd = update._meta?.terminal_info?.cwd;
	const lines: string[] = [];
	if (description) {
		lines.push(description, "");
	}
	lines.push("```sh", command, "```");
	if (typeof cwd === "string" && cwd.length > 0) {
		lines.push("", `Current directory:`, cwd);
	}
	return plainTextContent(lines.join("\n"));
}

function summarizeExecuteToolResult(update: Record<string, any>): ToolCallContent[] | undefined {
	const rawOutput = update.rawOutput;
	if (typeof rawOutput === "string") {
		return plainTextContent(markdownEscape(rawOutput || "Command completed with no output."));
	}
	return undefined;
}

function normalizeNativeToolUpdateForClient(
	update: SessionNotification["update"],
	clientCapabilities?: ClientCapabilities,
): SessionNotification["update"] {
	const supportsTerminalOutput = clientCapabilities?._meta?.["terminal_output"] === true;
	if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
		return update;
	}
	const rawInput = (update as Record<string, any>).rawInput;
	const command =
		rawInput && typeof rawInput === "object" && typeof rawInput.command === "string"
			? rawInput.command
			: "";
	const hasTerminalMeta = Boolean(
		(update as Record<string, any>)._meta?.terminal_info ||
		(update as Record<string, any>)._meta?.terminal_output ||
		(update as Record<string, any>)._meta?.terminal_exit,
	);
	const looksLikeShellTool =
		command.length > 0 ||
		hasTerminalMeta ||
		(update.kind === "execute" && !supportsTerminalOutput);
	if (!looksLikeShellTool) {
		return update;
	}

	const next: Record<string, any> = { ...update };
	if (update.sessionUpdate === "tool_call") {
		const content = summarizeExecuteToolCall(next);
		if (content) {
			next.content = content;
		}
		const command = typeof next.rawInput?.command === "string" ? next.rawInput.command : "";
		if (command) {
			next.title = `\`${command.split("`").join("\\`")}\``;
		}
	} else {
		const hasOnlyTerminalContent =
			Array.isArray(next.content) &&
			next.content.length > 0 &&
			next.content.every((item: any) => item?.type === "terminal");
		if (hasOnlyTerminalContent || !Array.isArray(next.content) || next.content.length === 0) {
			const content = summarizeExecuteToolResult(next);
			if (content) {
				next.content = content;
			}
		}
	}

	if (next._meta && typeof next._meta === "object") {
		const meta = { ...next._meta };
		delete meta.terminal_info;
		delete meta.terminal_output;
		delete meta.terminal_exit;
		next._meta = meta;
	}

	return next as SessionNotification["update"];
}

function appendDebugLog(label: string, value: unknown): void {
	if (process.env.CURSOR_ACP_DEBUG_LOG !== "1") {
		return;
	}
	try {
		const dir = path.join(getCursorAcpConfigDir(), "logs");
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, "debug.log");
		const line = `[${new Date().toISOString()}] ${label} ${JSON.stringify(value)}\n`;
		fs.appendFileSync(file, line, "utf-8");
	} catch {}
}

interface ActivePromptState {
	assistantTextChunks: string[];
	turnArtifacts: TurnArtifact[];
}

interface ActiveRunState {
	cancel: () => void;
}

interface PromptAttemptResult {
	stopReason: PromptResponse["stopReason"];
	rejectedToolCalls: RejectedToolCall[];
}

interface SessionState {
	sessionId: string;
	cwd: string;
	mcpServers?: NewSessionRequest["mcpServers"];
	modeId: SessionModeId;
	modelId?: string;
	lastAgentModeId: "default" | "yolo";
	cancelled: boolean;
	activePrompt?: ActivePromptState;
	activeRun?: ActiveRunState;
	backendSessionId?: string;
	/** Populated from native `session/new` or `session/load` when available. */
	nativeSessionModels?: NewSessionResponse["models"];
	/** Set when `createBackend` attempted native `session/load`: `true` if load worked, `false` if we fell back to `session/new`. */
	nativeLoadSucceeded?: boolean;
	nativeAvailableCommands: AvailableCommand[];
	nativeClient?: NativeSessionBackend;
	notificationsReady: boolean;
	pendingNotifications: SessionNotification[];
}

export interface CursorAcpAgentOptions {
	runner?: CursorCliRunner;
	auth?: CursorAuthClient;
	logger?: Logger;
	createNativeClient?: (
		options: CreateNativeSessionOptions,
		callbacks: NativeSessionCallbacks,
	) => NativeSessionBackend;
	nativeCommand?: string;
}

export class CursorAcpAgent implements Agent {
	private readonly sessions: Record<string, SessionState> = {};
	private clientCapabilities?: ClientCapabilities;

	private readonly runner: CursorCliRunner;
	private readonly auth: CursorAuthClient;
	private readonly logger: Logger;
	private readonly createNativeClient: (
		options: CreateNativeSessionOptions,
		callbacks: NativeSessionCallbacks,
	) => NativeSessionBackend;
	private readonly nativeCommand?: string;

	constructor(
		private readonly client: AgentSideConnection,
		options: CursorAcpAgentOptions = {},
	) {
		this.runner = options.runner ?? new CursorCliRunner();
		this.auth = options.auth ?? new CursorAuth();
		this.logger = options.logger ?? console;
		this.nativeCommand = options.nativeCommand;
		this.createNativeClient =
			options.createNativeClient ??
			((nativeOptions, callbacks) => new CursorNativeAcpClient(nativeOptions, callbacks));
	}

	async initialize(request: InitializeRequest): Promise<InitializeResponse> {
		this.clientCapabilities = request.clientCapabilities;
		appendDebugLog("initialize.clientCapabilities", request.clientCapabilities ?? null);

		const authMethod: NonNullable<InitializeResponse["authMethods"]>[number] = {
			id: "cursor_login",
			name: "Cursor Login",
			description: "Authenticate using Cursor CLI credentials",
		};

		if (request.clientCapabilities?._meta?.["terminal-auth"] === true) {
			authMethod._meta = {
				"terminal-auth": {
					command: this.nativeCommand ?? "agent",
					args: ["login"],
					label: "Cursor CLI Login",
				},
			};
		}

		return {
			protocolVersion: 1,
			agentCapabilities: {
				loadSession: true,
				mcpCapabilities: {
					http: true,
					sse: true,
				},
				promptCapabilities: {
					image: true,
					embeddedContext: true,
				},
				sessionCapabilities: {
					_meta: {
						supportsSessionModes: true,
						supportsSetMode: true,
						supportsSetModel: true,
					},
					fork: {},
					resume: {},
					list: {},
				},
			},
			agentInfo: {
				name: packageJson.name,
				title: "Cursor CLI",
				version: packageJson.version,
			},
			authMethods: [authMethod],
		};
	}

	async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		const sessionId = randomUUID();
		return await this.createSession({
			sessionId,
			cwd: params.cwd,
			mcpServers: params.mcpServers,
			preferredModeId: this.extractRequestedInitialMode(params),
			preferredModelId: this.extractRequestedInitialModel(params),
			warmNativeBackend: true,
		});
	}

	async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
		const sessionId = randomUUID();
		return await this.createSession({
			sessionId,
			cwd: params.cwd,
		});
	}

	async unstable_resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		const response = await this.createSession({
			sessionId: params.sessionId,
			cwd: params.cwd,
			mcpServers: params.mcpServers,
		});

		const session = this.requireSession(params.sessionId);
		const filePath = await findSessionFile(params.sessionId, params.cwd);
		const meta = filePath ? await readSessionMeta(filePath) : {};

		const loggedIn = (await this.auth.status()).loggedIn;

		return await this.withDeferredSessionNotifications(session, async () => {
			const notificationStartIndex = session.pendingNotifications.length;
			if (loggedIn && meta.backendSessionId) {
				await this.createBackend(session, { loadNativeSessionId: meta.backendSessionId });
			}

			if (
				filePath &&
				!this.hasConversationHistoryNotifications(
					session.pendingNotifications.slice(notificationStartIndex),
				)
			) {
				await this.replayStoredSessionHistory(session, filePath);
			}

			return this.buildResumeResponse(session, response);
		});
	}

	async unstable_listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		const PAGE_SIZE = 50;
		const sessions = await listSessions(params.cwd ?? undefined);

		let startIndex = 0;
		if (params.cursor) {
			try {
				const decoded = Buffer.from(params.cursor, "base64").toString("utf-8");
				const cursorData = JSON.parse(decoded) as { offset?: unknown };
				if (typeof cursorData.offset === "number" && cursorData.offset >= 0) {
					startIndex = cursorData.offset;
				}
			} catch {
				// Invalid cursor, start from the beginning.
			}
		}

		const pageOfSessions = sessions.slice(startIndex, startIndex + PAGE_SIZE);
		const hasMore = startIndex + PAGE_SIZE < sessions.length;

		if (!hasMore) {
			return { sessions: pageOfSessions };
		}

		const nextCursor = Buffer.from(JSON.stringify({ offset: startIndex + PAGE_SIZE })).toString(
			"base64",
		);

		return {
			sessions: pageOfSessions,
			nextCursor,
		};
	}

	/** Compatibility alias for clients that call stable `session/list`. */
	async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		return await this.unstable_listSessions(params);
	}

	async loadSession(params: {
		sessionId: string;
		cwd: string;
		mcpServers?: NewSessionRequest["mcpServers"];
	}): Promise<{
		modes: NewSessionResponse["modes"];
		models: NewSessionResponse["models"];
	}> {
		const filePath = await findSessionFile(params.sessionId, params.cwd);
		if (!filePath) {
			this.logger.error(
				`[cursor-acp] Session file not found for sessionId: ${params.sessionId}, creating new session`,
			);

			const response = await this.createSession({
				sessionId: params.sessionId,
				cwd: params.cwd,
				mcpServers: params.mcpServers,
			});

			return {
				modes: response.modes,
				models: response.models,
			};
		}

		const response = await this.createSession({
			sessionId: params.sessionId,
			cwd: params.cwd,
			mcpServers: params.mcpServers,
		});

		const session = this.requireSession(params.sessionId);
		const meta = await readSessionMeta(filePath);

		const loggedIn = (await this.auth.status()).loggedIn;

		return await this.withDeferredSessionNotifications(session, async () => {
			const notificationStartIndex = session.pendingNotifications.length;
			if (loggedIn && meta.backendSessionId) {
				await this.createBackend(session, { loadNativeSessionId: meta.backendSessionId });
			}

			if (
				!this.hasConversationHistoryNotifications(
					session.pendingNotifications.slice(notificationStartIndex),
				)
			) {
				await this.replayStoredSessionHistory(session, filePath);
			}

			return {
				modes: availableModes(session.modeId),
				models: session.nativeSessionModels ?? response.models,
			};
		});
	}

	async authenticate(params: AuthenticateRequest): Promise<void> {
		if (params.methodId !== "cursor_login" && params.methodId !== "cursor-login") {
			throw RequestError.invalidParams(`Unsupported auth method: ${params.methodId}`);
		}

		const status = await this.auth.ensureLoggedIn();
		if (!status.loggedIn) {
			throw RequestError.authRequired();
		}
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const session = this.requireSession(params.sessionId);
		const promptText = promptToCursorText(params);

		const slash = parseLeadingSlashCommand(promptText);
		if (slash.hasSlash) {
			if (!this.hasNativeSlashCommand(session, slash.command)) {
				const handled = await handleSlashCommand(slash.command, slash.args, {
					session,
					auth: this.auth,
					listModels: async () => await this.runner.listModels(),
					availableCommands: availableSlashCommands(session.nativeAvailableCommands),
					onModeChanged: async (modeId) => {
						await this.applySessionMode(session, modeId);
					},
					onModelChanged: async (modelId) => {
						session.modelId = modelId;
						if (session.nativeClient?.alive) {
							await this.restartBackend(session);
						}
					},
				});

				if (handled.handled) {
					if (session.cancelled) {
						return { stopReason: "cancelled" };
					}

					if (handled.responseText) {
						await this.client.sessionUpdate({
							sessionId: session.sessionId,
							update: {
								sessionUpdate: "agent_message_chunk",
								content: {
									type: "text",
									text: handled.responseText,
								},
							},
						});
						await recordAssistantMessage(
							session.cwd,
							session.sessionId,
							handled.responseText,
						);
					}

					return { stopReason: "end_turn" };
				}
			}
		}

		const status = await this.auth.status();
		if (!status.loggedIn) {
			throw RequestError.authRequired();
		}

		if (session.activePrompt || session.activeRun) {
			throw RequestError.invalidParams(
				undefined,
				"Cannot send a prompt while another prompt is in progress",
			);
		}

		session.cancelled = false;
		await recordUserMessage(session.cwd, session.sessionId, promptText);
		const firstAttempt = await this.runPromptAttempt(session, promptText, false);

		if (firstAttempt.stopReason === "cancelled" || session.cancelled) {
			return { stopReason: "cancelled" };
		}

		if (
			firstAttempt.stopReason === "end_turn" &&
			session.modeId === "default" &&
			firstAttempt.rejectedToolCalls.length > 0
		) {
			const approved = await this.requestPermissionToRetry(
				session.sessionId,
				firstAttempt.rejectedToolCalls[0]!,
			);

			if (session.cancelled) {
				return { stopReason: "cancelled" };
			}

			if (approved === "allow_always") {
				session.modeId = "yolo";
				await this.client.sessionUpdate({
					sessionId: session.sessionId,
					update: {
						sessionUpdate: "current_mode_update",
						currentModeId: session.modeId,
					},
				});
			}

			if (approved === "allow_once" || approved === "allow_always") {
				return await this.runPromptAttempt(session, promptText, true);
			}
		}

		return { stopReason: firstAttempt.stopReason };
	}

	async cancel(params: CancelNotification): Promise<void> {
		const session = this.requireSession(params.sessionId);
		session.cancelled = true;
		session.activeRun?.cancel();
		await session.nativeClient?.cancel();
	}

	async unstable_setSessionModel(
		params: SetSessionModelRequest,
	): Promise<SetSessionModelResponse | void> {
		const session = this.requireSession(params.sessionId);
		if (session.activePrompt || session.activeRun) {
			throw RequestError.invalidParams("Cannot change model during an active prompt");
		}

		session.modelId = normalizeModelId(params.modelId);
		await this.restartBackend(session);
		return {};
	}

	async extMethod(
		method: string,
		params: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		if (method === "session/set_model") {
			const response = await this.unstable_setSessionModel(params as SetSessionModelRequest);
			return (response ?? {}) as Record<string, unknown>;
		}

		throw RequestError.methodNotFound(method);
	}

	async extNotification(_method: string, _params: Record<string, unknown>): Promise<void> {}

	async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
		const session = this.requireSession(params.sessionId);
		const modeId = normalizeModeId(params.modeId);
		if (!modeId) {
			throw RequestError.invalidParams(`Invalid mode: ${params.modeId}`);
		}

		await this.applySessionMode(session, modeId);
		return {};
	}

	async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
		return await this.client.readTextFile(params);
	}

	async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
		return await this.client.writeTextFile(params);
	}

	private async createSession(params: {
		sessionId: string;
		cwd: string;
		mcpServers?: NewSessionRequest["mcpServers"];
		preferredModeId?: SessionModeId;
		preferredModelId?: string;
		warmNativeBackend?: boolean;
	}): Promise<NewSessionResponse> {
		const modeId = params.preferredModeId ?? DEFAULT_MODE_ID;
		const session: SessionState = {
			sessionId: params.sessionId,
			cwd: params.cwd,
			mcpServers: params.mcpServers,
			modeId,
			modelId: params.preferredModelId,
			lastAgentModeId: modeId === "yolo" ? "yolo" : "default",
			cancelled: false,
			nativeAvailableCommands: [],
			notificationsReady: false,
			pendingNotifications: [],
		};

		this.sessions[session.sessionId] = session;

		const fallbackModels = await this.getAvailableModels(session);
		if (params.warmNativeBackend) {
			await this.maybeWarmNativeBackendOnSessionCreate(session);
		}
		session.notificationsReady = true;
		setTimeout(() => {
			void this.flushPendingNotifications(session);
		}, 0);

		return {
			sessionId: session.sessionId,
			models: session.nativeSessionModels ?? fallbackModels,
			modes: availableModes(session.modeId),
		};
	}

	private async maybeWarmNativeBackendOnSessionCreate(session: SessionState): Promise<void> {
		try {
			const status = await this.auth.status();
			if (!status.loggedIn) {
				return;
			}
		} catch (error) {
			this.logger.warn?.(
				"[cursor-acp] Unable to determine auth status during session creation",
				error,
			);
			return;
		}

		try {
			await this.createBackend(session);
		} catch (error) {
			this.logger.warn?.(
				"[cursor-acp] Unable to warm native ACP backend during session creation",
				error,
			);
		}
	}

	private extractRequestedInitialMode(params: NewSessionRequest): SessionModeId | undefined {
		const raw = params as unknown as {
			modeId?: unknown;
			mode_id?: unknown;
			mode?: unknown;
			defaultModeId?: unknown;
			default_mode?: unknown;
			_meta?: {
				modeId?: unknown;
				mode_id?: unknown;
				mode?: unknown;
				defaultModeId?: unknown;
				default_mode?: unknown;
			};
		};

		const candidates = [
			raw.modeId,
			raw.mode_id,
			raw.mode,
			raw.defaultModeId,
			raw.default_mode,
			raw._meta?.modeId,
			raw._meta?.mode_id,
			raw._meta?.mode,
			raw._meta?.defaultModeId,
			raw._meta?.default_mode,
		];

		for (const candidate of candidates) {
			if (typeof candidate !== "string") {
				continue;
			}
			const normalized = normalizeModeId(candidate.trim());
			if (normalized) {
				return normalized;
			}
		}

		return undefined;
	}

	private extractRequestedInitialModel(params: NewSessionRequest): string | undefined {
		const raw = params as unknown as {
			modelId?: unknown;
			model_id?: unknown;
			model?: unknown;
			defaultModelId?: unknown;
			default_model?: unknown;
			_meta?: {
				modelId?: unknown;
				model_id?: unknown;
				model?: unknown;
				defaultModelId?: unknown;
				default_model?: unknown;
			};
		};

		const candidates = [
			raw.modelId,
			raw.model_id,
			raw.model,
			raw.defaultModelId,
			raw.default_model,
			raw._meta?.modelId,
			raw._meta?.model_id,
			raw._meta?.model,
			raw._meta?.defaultModelId,
			raw._meta?.default_model,
		];

		for (const candidate of candidates) {
			if (typeof candidate !== "string") {
				continue;
			}
			const trimmed = normalizeModelId(candidate);
			if (trimmed.length > 0) {
				return trimmed;
			}
		}

		return undefined;
	}

	private async createBackend(
		session: SessionState,
		options?: { loadNativeSessionId?: string },
	): Promise<void> {
		const nativeClient = this.createNativeClient(
			{
				clientCapabilities: this.clientCapabilities,
				command: this.nativeCommand,
				cwd: session.cwd,
				logger: this.logger,
				mcpServers: session.mcpServers,
				modelId: session.modelId,
			},
			{
				onSessionUpdate: async (notification) => {
					await this.handleNativeSessionUpdate(session, notification);
				},
				onRequestPermission: async (request) => {
					return await this.handleNativePermissionRequest(session, request);
				},
				onExtMethod: async (method, params) => {
					return await this.client.extMethod(
						method,
						this.rewriteNativeExtensionParams(session, params),
					);
				},
				onExtNotification: async (method, params) => {
					await this.client.extNotification(
						method,
						this.rewriteNativeExtensionParams(session, params),
					);
				},
				onReadTextFile: async (request) => await this.client.readTextFile(request),
				onWriteTextFile: async (request) => await this.client.writeTextFile(request),
				onUnexpectedClose: (error) => {
					if (session.nativeClient === nativeClient) {
						session.nativeClient = undefined;
						session.backendSessionId = undefined;
					}
					this.logger.error("[cursor-acp] native ACP backend closed", error);
				},
			},
		);

		session.nativeClient = nativeClient;

		const loadId = options?.loadNativeSessionId;

		if (loadId) {
			try {
				const loaded = await nativeClient.loadSessionBackend(loadId);
				session.backendSessionId = loadId;
				await this.applyNativeSessionModelsAndModes(session, loaded);
				session.nativeLoadSucceeded = true;
			} catch (error) {
				this.logger.warn?.(
					"[cursor-acp] Native session/load failed; starting a new native session",
					error,
				);
				session.nativeLoadSucceeded = false;
				const response = await nativeClient.createSessionBackend();
				session.backendSessionId = response.sessionId;
				await this.applyNativeSessionModelsAndModes(session, response);
			}
		} else {
			const response = await nativeClient.createSessionBackend();
			session.backendSessionId = response.sessionId;
			await this.applyNativeSessionModelsAndModes(session, response);
		}

		try {
			await recordSessionMeta(session.cwd, session.sessionId, session.backendSessionId);
		} catch (error) {
			this.logger.error("[cursor-acp] Failed to record session meta", error);
		}

		await this.applyNativeModeAfterConnect(session, nativeClient);
	}

	private async applyNativeSessionModelsAndModes(
		session: SessionState,
		loaded: {
			models?: NewSessionResponse["models"];
			modes?: NewSessionResponse["modes"];
		},
	): Promise<void> {
		if (loaded.models) {
			let listedModels: CursorModelDescriptor[] = [];
			try {
				listedModels = await this.runner.listModels();
			} catch (error) {
				this.logger.warn?.(
					"[cursor-acp] Unable to refresh full model list from CLI",
					error,
				);
			}

			const availableModels =
				listedModels.length > 0
					? listedModels.map((model) => ({
							modelId: model.modelId,
							name: this.modelDisplayName(model.modelId, model.name),
							description: this.modelHoverDescription(model.modelId, model.name),
						}))
					: [
							...new Map(
								(loaded.models.availableModels ?? []).map((model) => {
									const normalizedModelId = normalizeModelId(model.modelId);
									return [
										normalizedModelId,
										{
											modelId: normalizedModelId,
											name: this.modelDisplayName(
												normalizedModelId,
												model.name,
											),
											description: this.modelHoverDescription(
												normalizedModelId,
												model.description ?? model.name,
											),
										},
									];
								}),
							).values(),
						];

			const resolvedSessionModelId = resolveModelId(session.modelId, listedModels);
			const resolvedNativeCurrentModelId = resolveModelId(
				loaded.models.currentModelId,
				listedModels,
			);
			session.modelId = resolvedSessionModelId;

			const currentModelId =
				resolvedNativeCurrentModelId ??
				listedModels.find((model) => model.current)?.modelId ??
				resolvedSessionModelId ??
				availableModels[0]?.modelId;

			session.nativeSessionModels = {
				...loaded.models,
				currentModelId,
				availableModels,
			};
			if (currentModelId) {
				session.modelId = currentModelId;
			}
		}

		if (loaded.modes?.currentModeId) {
			const translated = this.translateNativeMode(session, loaded.modes.currentModeId);
			session.modeId = translated;
			if (translated === "default" || translated === "yolo") {
				session.lastAgentModeId = translated;
			}
		}
	}

	private async applyNativeModeAfterConnect(
		session: SessionState,
		nativeClient: NativeSessionBackend,
	): Promise<void> {
		if (session.modeId === "ask" || session.modeId === "plan") {
			await nativeClient.setNativeMode(this.modeToNativeMode(session.modeId));
		}
	}

	private buildResumeResponse(
		session: SessionState,
		fallback: NewSessionResponse,
	): ResumeSessionResponse {
		return {
			models: session.nativeSessionModels ?? fallback.models,
			modes: availableModes(session.modeId),
		};
	}

	private hasConversationHistoryNotifications(notifications: SessionNotification[]): boolean {
		return notifications.some(
			(notification) =>
				notification.update.sessionUpdate === "user_message_chunk" ||
				notification.update.sessionUpdate === "agent_message_chunk",
		);
	}

	private async replayStoredSessionHistory(
		session: SessionState,
		filePath: string,
	): Promise<void> {
		await replaySessionHistory({
			sessionId: session.sessionId,
			filePath,
			sendNotification: async (notification) => {
				await this.emitOrQueueNotification(session, notification);
			},
		});
	}

	private async withDeferredSessionNotifications<T>(
		session: SessionState,
		work: () => Promise<T>,
	): Promise<T> {
		if (!session.notificationsReady) {
			return await work();
		}

		session.notificationsReady = false;
		try {
			return await work();
		} finally {
			session.notificationsReady = true;
			setTimeout(() => {
				void this.flushPendingNotifications(session);
			}, 0);
		}
	}

	private async ensureBackend(session: SessionState): Promise<void> {
		if (session.nativeClient?.alive) {
			return;
		}

		await this.createBackend(session);
	}

	private async restartBackend(session: SessionState): Promise<void> {
		if (session.activePrompt) {
			throw RequestError.invalidParams("Cannot restart backend during an active prompt");
		}

		await session.nativeClient?.close();
		session.nativeClient = undefined;
		session.backendSessionId = undefined;
		await this.createBackend(session);
	}

	private async getAvailableModels(session: SessionState) {
		let listed: CursorModelDescriptor[] = [];
		try {
			listed = await this.runner.listModels();
		} catch (error) {
			this.logger.error("[cursor-acp] Unable to list models", error);
		}

		session.modelId = resolveModelId(session.modelId, listed);

		const availableModels = listed.map((model) => ({
			modelId: model.modelId,
			name: model.name,
			description: this.modelHoverDescription(model.modelId, model.name),
		}));

		const hasSelectedModel =
			typeof session.modelId === "string" &&
			listed.some((model) => model.modelId === session.modelId);
		if (!hasSelectedModel) {
			session.modelId = listed.find((model) => model.current)?.modelId ?? listed[0]?.modelId;
		}

		return {
			availableModels,
			currentModelId: session.modelId ?? "auto",
		};
	}

	private modelHoverDescription(modelId: string, baseDescription: string): string {
		return `${baseDescription} (id: ${modelId})`;
	}

	private modelDisplayName(_modelId: string, name: string): string {
		return name;
	}

	private async finalizeAssistantTurnCapture(
		session: SessionState,
		result: PromptResponse,
	): Promise<void> {
		const active = session.activePrompt;
		if (!active) {
			return;
		}
		if (result.stopReason !== "end_turn") {
			return;
		}

		let text = active.assistantTextChunks.join("");
		if (text.trim().length === 0 && active.turnArtifacts.length > 0) {
			text = formatTurnRecapMarkdown(active.turnArtifacts);
			if (text.length > 0) {
				await this.emitOrQueueNotification(session, {
					sessionId: session.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: `${text}\n` },
					},
				});
			}
		}

		const trimmed = text.trim();
		if (trimmed.length > 0) {
			await recordAssistantMessage(session.cwd, session.sessionId, trimmed);
		}
	}

	private modeToRunnerOptions(
		session: SessionState,
		forceRetry: boolean,
	): {
		modeId?: "plan" | "ask";
		force: boolean;
	} {
		if (forceRetry) {
			return { force: true };
		}

		switch (session.modeId) {
			case "plan":
				return { modeId: "plan", force: false };
			case "ask":
				return { modeId: "ask", force: false };
			case "yolo":
				return { force: true };
			case "default":
				return { force: false };
			default:
				unreachable(session.modeId, this.logger);
		}
	}

	private async ensureLegacyBackendSessionId(session: SessionState): Promise<void> {
		if (session.backendSessionId) {
			return;
		}

		try {
			session.backendSessionId = await this.runner.createChat();
			await recordSessionMeta(session.cwd, session.sessionId, session.backendSessionId);
		} catch (error) {
			this.logger.error(
				"[cursor-acp] create-chat failed, using lazy backend session binding",
				error,
			);
		}
	}

	private async runPromptAttempt(
		session: SessionState,
		promptText: string,
		forceRetry: boolean,
	): Promise<PromptAttemptResult> {
		const rejectedToolCalls: RejectedToolCall[] = [];
		const toolUseCache: Record<string, CachedToolUse> = {};
		const modeSettings = this.modeToRunnerOptions(session, forceRetry);
		const assistantTextChunks: string[] = [];

		await this.ensureLegacyBackendSessionId(session);

		const run = this.runner.startPrompt({
			workspace: session.cwd,
			backendSessionId: session.backendSessionId,
			prompt: promptText,
			modelId: session.modelId,
			modeId: modeSettings.modeId,
			force: modeSettings.force,
			onEvent: async (event) => {
				const mapped = mapCursorEventToAcp(event, {
					sessionId: session.sessionId,
					toolUseCache,
					logger: this.logger,
				});

				if (mapped.backendSessionId) {
					session.backendSessionId = mapped.backendSessionId;
					await recordSessionMeta(
						session.cwd,
						session.sessionId,
						session.backendSessionId,
					);
				}

				if (mapped.currentModeId) {
					const translated = normalizeModeId(mapped.currentModeId);
					if (translated) {
						session.modeId = translated;
					}
				}

				if (mapped.rejectedToolCall) {
					rejectedToolCalls.push(mapped.rejectedToolCall);
				}

				for (const notification of mapped.notifications) {
					if (
						notification.update.sessionUpdate === "agent_message_chunk" &&
						notification.update.content?.type === "text"
					) {
						assistantTextChunks.push(notification.update.content.text);
					}
					await this.client.sessionUpdate(notification);
				}
			},
		});

		session.activeRun = run;

		try {
			const completed = await run.completed;
			session.activeRun = undefined;

			if (session.cancelled) {
				return {
					stopReason: "cancelled",
					rejectedToolCalls,
				};
			}

			const resultEvent = completed.resultEvent;
			if (!resultEvent) {
				throw RequestError.internalError(
					undefined,
					"Cursor CLI did not emit a result event",
				);
			}

			const subtype = typeof resultEvent.subtype === "string" ? resultEvent.subtype : "";
			const isError = resultEvent.is_error === true;

			if (subtype === "success" && !isError) {
				if (assistantTextChunks.length > 0) {
					await recordAssistantMessage(
						session.cwd,
						session.sessionId,
						assistantTextChunks.join(""),
					);
				}
				return {
					stopReason: "end_turn",
					rejectedToolCalls,
				};
			}

			if (
				subtype.includes("max_turn") ||
				subtype.includes("max_budget") ||
				subtype.includes("max_structured")
			) {
				return {
					stopReason: "max_turn_requests",
					rejectedToolCalls,
				};
			}

			const resultText =
				typeof resultEvent.result === "string" ? resultEvent.result : subtype;
			throw RequestError.internalError(undefined, resultText || "Cursor CLI failed");
		} catch (error) {
			session.activeRun = undefined;
			if (session.cancelled) {
				return {
					stopReason: "cancelled",
					rejectedToolCalls,
				};
			}

			if (error instanceof RequestError) {
				throw error;
			}

			throw RequestError.internalError(undefined, String(error));
		}
	}

	private async requestPermissionToRetry(
		sessionId: string,
		rejectedToolCall: RejectedToolCall,
	): Promise<"allow_once" | "allow_always" | "reject"> {
		const response = await this.client.requestPermission({
			options: [
				{
					kind: "allow_once",
					name: "Allow once",
					optionId: "allow_once",
				},
				{
					kind: "allow_always",
					name: "Always allow",
					optionId: "allow_always",
				},
				{
					kind: "reject_once",
					name: "Reject",
					optionId: "reject",
				},
			],
			sessionId,
			toolCall: {
				toolCallId: rejectedToolCall.toolCallId,
				rawInput: rejectedToolCall.rawInput,
				title: rejectedToolCall.title,
			},
		});

		if (response.outcome?.outcome !== "selected") {
			return "reject";
		}

		switch (response.outcome.optionId) {
			case "allow_once":
			case "allow_always":
				return response.outcome.optionId;
			case "reject":
			default:
				return "reject";
		}
	}

	private async handleNativeSessionUpdate(
		session: SessionState,
		notification: SessionNotification,
	): Promise<void> {
		appendDebugLog("native.update.raw", notification.update);
		const update = normalizeNativeToolUpdateForClient(
			notification.update,
			this.clientCapabilities,
		);
		appendDebugLog("native.update.normalized", update);

		if (session.activePrompt) {
			appendAssistantTextFromNativeChunk(update, session.activePrompt.assistantTextChunks);
			recordTurnArtifactsFromNativeSessionUpdate(session.activePrompt.turnArtifacts, update);
		}

		if (update.sessionUpdate === "current_mode_update") {
			const translatedMode = this.translateNativeMode(session, update.currentModeId);
			session.modeId = translatedMode;
			await this.emitOrQueueNotification(session, {
				sessionId: session.sessionId,
				update: {
					sessionUpdate: "current_mode_update",
					currentModeId: translatedMode,
				},
			});
			return;
		}

		if (update.sessionUpdate === "available_commands_update") {
			session.nativeAvailableCommands = update.availableCommands ?? [];
			await this.emitOrQueueNotification(session, {
				sessionId: session.sessionId,
				update: {
					sessionUpdate: "available_commands_update",
					availableCommands: availableSlashCommands(session.nativeAvailableCommands),
				},
			});
			return;
		}

		await this.emitOrQueueNotification(session, {
			sessionId: session.sessionId,
			update,
		});
	}

	private async emitOrQueueNotification(
		session: SessionState,
		notification: SessionNotification,
	): Promise<void> {
		if (!session.notificationsReady) {
			session.pendingNotifications.push(notification);
			return;
		}

		await this.client.sessionUpdate(notification);
	}

	private async flushPendingNotifications(session: SessionState): Promise<void> {
		if (!session.notificationsReady || session.pendingNotifications.length === 0) {
			return;
		}

		const notifications = session.pendingNotifications.splice(0);
		for (const notification of notifications) {
			await this.client.sessionUpdate(notification);
		}
	}

	private hasNativeSlashCommand(session: SessionState, commandName: string): boolean {
		const normalized = normalizeSlashCommandName(commandName).toLowerCase();
		return session.nativeAvailableCommands.some(
			(command) => normalizeSlashCommandName(command.name).toLowerCase() === normalized,
		);
	}

	/**
	 * Native `agent acp` uses the backend session id in payloads; the outer ACP client
	 * only knows the wrapper session id. Rewrite when the id is missing or matches the backend.
	 */
	private rewriteNativeExtensionParams(
		session: SessionState,
		params: Record<string, unknown>,
	): Record<string, unknown> {
		const sid = params.sessionId;
		const backendId = session.backendSessionId;
		if (
			sid === undefined ||
			(typeof sid === "string" && backendId !== undefined && sid === backendId)
		) {
			return { ...params, sessionId: session.sessionId };
		}

		return { ...params };
	}

	private async handleNativePermissionRequest(
		session: SessionState,
		request: RequestPermissionRequest,
	): Promise<RequestPermissionResponse> {
		if (session.cancelled) {
			return { outcome: { outcome: "cancelled" } };
		}

		if (session.modeId === "yolo") {
			return this.approvePermissionRequest(request);
		}

		return await this.client.requestPermission({
			...request,
			sessionId: session.sessionId,
		});
	}

	private approvePermissionRequest(request: RequestPermissionRequest): RequestPermissionResponse {
		const normalizedKinds = request.options.map((option) => ({
			optionId: option.optionId,
			kind: option.kind.replace(/-/g, "_"),
		}));

		const allowAlways = normalizedKinds.find((option) => option.kind === "allow_always");
		if (allowAlways) {
			return {
				outcome: {
					outcome: "selected",
					optionId: allowAlways.optionId,
				},
			};
		}

		const allowOnce = normalizedKinds.find((option) => option.kind === "allow_once");
		if (allowOnce) {
			return {
				outcome: {
					outcome: "selected",
					optionId: allowOnce.optionId,
				},
			};
		}

		const fallback = request.options.find((option) => option.kind.startsWith("allow"));
		if (!fallback) {
			throw RequestError.internalError(
				undefined,
				"Native ACP permission request did not expose an allow option",
			);
		}

		return {
			outcome: {
				outcome: "selected",
				optionId: fallback.optionId,
			},
		};
	}

	private modeToNativeMode(modeId: SessionModeId): NativeModeId {
		switch (modeId) {
			case "default":
			case "yolo":
				return "agent";
			case "ask":
				return "ask";
			case "plan":
				return "plan";
		}
	}

	private translateNativeMode(session: SessionState, nativeModeId: string): SessionModeId {
		switch (nativeModeId) {
			case "agent":
				return session.lastAgentModeId;
			case "ask":
				return "ask";
			case "plan":
				return "plan";
			default:
				return session.modeId;
		}
	}

	private async applySessionMode(session: SessionState, modeId: SessionModeId): Promise<void> {
		session.modeId = modeId;
		if (modeId === "default" || modeId === "yolo") {
			session.lastAgentModeId = modeId;
		}

		if (!session.nativeClient?.alive) {
			return;
		}

		const nativeMode = this.modeToNativeMode(modeId);
		await session.nativeClient!.setNativeMode(nativeMode);
	}

	private requireSession(sessionId: string): SessionState {
		const session = this.sessions[sessionId];
		if (!session) {
			throw RequestError.invalidParams("Session not found");
		}

		return session;
	}
}

export function maybeEmitSessionUpdate(
	client: AgentSideConnection,
	notification: SessionNotification,
): Promise<void> {
	return client.sessionUpdate(notification);
}
