import {
	Agent,
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
	SetSessionModeRequest,
	SetSessionModeResponse,
	SetSessionConfigOptionRequest,
	SetSessionConfigOptionResponse,
	SessionConfigOption,
	SessionNotification,
	ToolCallContent,
	WriteTextFileRequest,
	WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import packageJson from "../package.json" with { type: "json" };
import {
	ExtendedInitializeRequest,
	looseSessionDefaults,
	type LooseSessionDefaults,
} from "./acp-request-extensions.js";
import { CursorAuth, CursorAuthClient } from "./auth.js";
import type { CursorAcpClient } from "./cursor-acp-client.js";
import { CachedToolUse, mapCursorEventToAcp, RejectedToolCall } from "./cursor-event-mapper.js";
import {
	CreateNativeSessionOptions,
	CursorNativeAcpClient,
	NativeModeId,
	NativeSessionBackend,
	NativeSessionCallbacks,
} from "./cursor-native-acp-client.js";
import type { CursorRunner, RunPromptOptions } from "./cursor-runner.js";
import { CursorSdkRunner } from "./cursor-sdk-runner.js";
import type {
	ExtendedNewSessionResponse,
	ExtendedResumeSessionResponse,
	LegacySessionModels,
	LegacySetSessionModelRequest,
	LegacySetSessionModelResponse,
} from "./legacy-session-models.js";
import {
	applyFastValue,
	applyThinkingValue,
	FAST_PARAM_ID,
	findParameterModelInCatalog,
	formatFastParameterOptionName,
	getFastParameterForModel,
	getThinkingParameterForModel,
	inferFastValueFromModelId,
	inferThinkingValueFromModelId,
	isValidFastValue,
	isValidThinkingLevel,
	mergeModelCatalogs,
	normalizeModelId,
	resolveDefaultFastValue,
	resolveDefaultThinkingLevel,
	resolveModelId,
	THINKING_PARAM_ID,
	withCliModelParameters,
} from "./model-id.js";
import {
	parseLeadingSlashCommand,
	promptToCursorImages,
	promptToCursorText,
} from "./prompt-conversion.js";
import {
	CustomSlashCommand,
	CursorModelDescriptor,
	handleSlashCommand,
	loadCustomSlashCommands,
	mergeAvailableSlashCommands,
	normalizeSlashCommandName,
	resolveCustomSlashCommandPrompt,
	resolveSkillSlashCommandPrompt,
} from "./slash-commands.js";
import { CustomSkill, loadCustomSkills } from "./skills.js";
import {
	AgentSessionModeId,
	availableModes,
	DEFAULT_MODE_ID,
	getEnvDefaultMode,
	getEnvDefaultModel,
	getEnvDefaultThinking,
	isAgentSessionMode,
	normalizeModeId,
	SessionModeId,
} from "./settings.js";
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
import { isObject, Logger, unreachable } from "./utils.js";
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

type ToolSessionUpdate = Extract<
	SessionNotification["update"],
	{ sessionUpdate: "tool_call" } | { sessionUpdate: "tool_call_update" }
>;

type ExecuteToolUpdate = ToolSessionUpdate & {
	rawInput?: { command?: string; description?: string };
	rawOutput?: string;
	_meta?: {
		terminal_info?: { cwd?: string };
		terminal_output?: unknown;
		terminal_exit?: unknown;
		[key: string]: unknown;
	};
};

function summarizeExecuteToolCall(update: ExecuteToolUpdate): ToolCallContent[] | undefined {
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

function summarizeExecuteToolResult(update: ExecuteToolUpdate): ToolCallContent[] | undefined {
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
	const toolUpdate = update as ExecuteToolUpdate;
	const rawInput = toolUpdate.rawInput;
	const command =
		rawInput && typeof rawInput === "object" && typeof rawInput.command === "string"
			? rawInput.command
			: "";
	const hasTerminalMeta = Boolean(
		toolUpdate._meta?.terminal_info ||
		toolUpdate._meta?.terminal_output ||
		toolUpdate._meta?.terminal_exit,
	);
	const looksLikeShellTool =
		command.length > 0 ||
		hasTerminalMeta ||
		(update.kind === "execute" && !supportsTerminalOutput);
	if (!looksLikeShellTool) {
		return update;
	}

	const next: ExecuteToolUpdate = { ...toolUpdate };
	if (update.sessionUpdate === "tool_call") {
		const content = summarizeExecuteToolCall(next);
		if (content) {
			next.content = content;
		}
		const command = typeof next.rawInput?.command === "string" ? next.rawInput.command : "";
		if (command) {
			next.title = command;
		}
	} else {
		const hasOnlyTerminalContent =
			Array.isArray(next.content) &&
			next.content.length > 0 &&
			next.content.every((item) => item.type === "terminal");
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

function normalizePermissionToolCallTitle(
	toolCall: RequestPermissionRequest["toolCall"],
): RequestPermissionRequest["toolCall"] {
	const rawInput = toolCall.rawInput;
	const command =
		isObject(rawInput) && typeof rawInput.command === "string" ? rawInput.command : "";

	return command ? { ...toolCall, title: command } : toolCall;
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

function pickNormalizedModeId(...candidates: unknown[]): SessionModeId | undefined {
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

function pickNormalizedModelId(...candidates: unknown[]): string | undefined {
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

function modeCandidatesFrom(raw: LooseSessionDefaults): unknown[] {
	return [
		raw.modeId,
		raw.mode_id,
		raw.mode,
		raw.defaultModeId,
		raw.default_mode,
		raw.defaultConfigOptions?.mode,
		raw.default_config_options?.mode,
		raw._meta?.modeId,
		raw._meta?.mode_id,
		raw._meta?.mode,
		raw._meta?.defaultModeId,
		raw._meta?.default_mode,
		raw._meta?.defaultConfigOptions?.mode,
		raw._meta?.default_config_options?.mode,
		raw.cursor?.modeId,
		raw.cursor?.mode_id,
		raw.cursor?.mode,
		raw.cursor?.defaultModeId,
		raw.cursor?.default_mode,
		raw.cursor?.defaultConfigOptions?.mode,
		raw.cursor?.default_config_options?.mode,
		raw._meta?.cursor?.modeId,
		raw._meta?.cursor?.mode_id,
		raw._meta?.cursor?.mode,
		raw._meta?.cursor?.defaultModeId,
		raw._meta?.cursor?.default_mode,
		raw._meta?.cursor?.defaultConfigOptions?.mode,
		raw._meta?.cursor?.default_config_options?.mode,
	];
}

function modelCandidatesFrom(raw: LooseSessionDefaults): unknown[] {
	return [
		raw.modelId,
		raw.model_id,
		raw.model,
		raw.defaultModelId,
		raw.default_model,
		raw.defaultConfigOptions?.model,
		raw.default_config_options?.model,
		raw._meta?.modelId,
		raw._meta?.model_id,
		raw._meta?.model,
		raw._meta?.defaultModelId,
		raw._meta?.default_model,
		raw._meta?.defaultConfigOptions?.model,
		raw._meta?.default_config_options?.model,
		raw.cursor?.modelId,
		raw.cursor?.model_id,
		raw.cursor?.model,
		raw.cursor?.defaultModelId,
		raw.cursor?.default_model,
		raw.cursor?.defaultConfigOptions?.model,
		raw.cursor?.default_config_options?.model,
		raw._meta?.cursor?.modelId,
		raw._meta?.cursor?.model_id,
		raw._meta?.cursor?.model,
		raw._meta?.cursor?.defaultModelId,
		raw._meta?.cursor?.default_model,
		raw._meta?.cursor?.defaultConfigOptions?.model,
		raw._meta?.cursor?.default_config_options?.model,
	];
}

function pickParameterValue(...candidates: unknown[]): string | undefined {
	for (const candidate of candidates) {
		if (typeof candidate === "boolean") {
			return String(candidate);
		}
		if (typeof candidate !== "string") {
			continue;
		}
		const trimmed = candidate.trim();
		if (trimmed.length > 0) {
			return trimmed;
		}
	}
	return undefined;
}

function thinkingCandidatesFrom(raw: LooseSessionDefaults): unknown[] {
	return [
		raw.thinkingLevel,
		raw.thinking_level,
		raw.thinking,
		raw.defaultThinkingLevel,
		raw.default_thinking_level,
		raw.defaultThinking,
		raw.default_thinking,
		raw.defaultConfigOptions?.thinking,
		raw.default_config_options?.thinking,
		raw._meta?.thinkingLevel,
		raw._meta?.thinking_level,
		raw._meta?.thinking,
		raw._meta?.defaultThinkingLevel,
		raw._meta?.default_thinking_level,
		raw._meta?.defaultThinking,
		raw._meta?.default_thinking,
		raw._meta?.defaultConfigOptions?.thinking,
		raw._meta?.default_config_options?.thinking,
		raw.cursor?.thinkingLevel,
		raw.cursor?.thinking_level,
		raw.cursor?.thinking,
		raw.cursor?.defaultThinkingLevel,
		raw.cursor?.default_thinking_level,
		raw.cursor?.defaultThinking,
		raw.cursor?.default_thinking,
		raw.cursor?.defaultConfigOptions?.thinking,
		raw.cursor?.default_config_options?.thinking,
		raw._meta?.cursor?.thinkingLevel,
		raw._meta?.cursor?.thinking_level,
		raw._meta?.cursor?.thinking,
		raw._meta?.cursor?.defaultThinkingLevel,
		raw._meta?.cursor?.default_thinking_level,
		raw._meta?.cursor?.defaultThinking,
		raw._meta?.cursor?.default_thinking,
		raw._meta?.cursor?.defaultConfigOptions?.thinking,
		raw._meta?.cursor?.default_config_options?.thinking,
	];
}

function fastCandidatesFrom(raw: LooseSessionDefaults): unknown[] {
	return [
		raw.fast,
		raw.defaultFast,
		raw.default_fast,
		raw.defaultConfigOptions?.fast,
		raw.default_config_options?.fast,
		raw._meta?.fast,
		raw._meta?.defaultFast,
		raw._meta?.default_fast,
		raw._meta?.defaultConfigOptions?.fast,
		raw._meta?.default_config_options?.fast,
		raw.cursor?.fast,
		raw.cursor?.defaultFast,
		raw.cursor?.default_fast,
		raw.cursor?.defaultConfigOptions?.fast,
		raw.cursor?.default_config_options?.fast,
		raw._meta?.cursor?.fast,
		raw._meta?.cursor?.defaultFast,
		raw._meta?.cursor?.default_fast,
		raw._meta?.cursor?.defaultConfigOptions?.fast,
		raw._meta?.cursor?.default_config_options?.fast,
	];
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

export interface SessionState {
	sessionId: string;
	cwd: string;
	mcpServers?: NewSessionRequest["mcpServers"];
	modeId: SessionModeId;
	modelId?: string;
	configuredModelId?: string;
	thinkingLevel?: string;
	configuredThinkingLevel?: string;
	fastValue?: string;
	configuredFastValue?: string;
	lastAgentModeId: AgentSessionModeId;
	cancelled: boolean;
	activePrompt?: ActivePromptState;
	activeRun?: ActiveRunState;
	backendSessionId?: string;
	/** Populated from native `session/new` or `session/load` when available. */
	nativeSessionModels?: LegacySessionModels;
	/** Populated from the active runner's model catalog. */
	fallbackSessionModels?: LegacySessionModels;
	/** Set when `createBackend` attempted native `session/load`: `true` if load worked, `false` if we fell back to `session/new`. */
	nativeLoadSucceeded?: boolean;
	nativeAvailableCommands: AvailableCommand[];
	customSlashCommands: CustomSlashCommand[];
	customSkills: CustomSkill[];
	nativeClient?: NativeSessionBackend;
	nativeModelId?: string;
	pendingNativeSessionId?: string;
	nativeStartPromise?: Promise<void>;
	configMutationPromise?: Promise<void>;
	appliedNativeModeId?: NativeModeId;
	notificationsReady: boolean;
	pendingNotifications: SessionNotification[];
	modelCatalog?: CursorModelDescriptor[];
}

export interface CursorAcpAgentOptions {
	runner?: CursorRunner;
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
	private defaultModeId?: SessionModeId;
	private defaultModelId?: string;
	private defaultThinkingLevel?: string;
	private defaultFastValue?: string;

	private readonly runner: CursorRunner;
	private readonly auth: CursorAuthClient;
	private readonly logger: Logger;
	private readonly createNativeClient: (
		options: CreateNativeSessionOptions,
		callbacks: NativeSessionCallbacks,
	) => NativeSessionBackend;
	private readonly nativeCommand?: string;

	constructor(
		private readonly client: CursorAcpClient,
		options: CursorAcpAgentOptions = {},
	) {
		this.logger = options.logger ?? console;
		this.runner = options.runner ?? new CursorSdkRunner(undefined, this.logger);
		this.auth = options.auth ?? new CursorAuth();
		this.nativeCommand = options.nativeCommand;
		this.createNativeClient =
			options.createNativeClient ??
			((nativeOptions, callbacks) => new CursorNativeAcpClient(nativeOptions, callbacks));
	}

	async initialize(request: InitializeRequest): Promise<InitializeResponse> {
		this.clientCapabilities = request.clientCapabilities;
		appendDebugLog("initialize.clientCapabilities", request.clientCapabilities ?? null);

		const initDefaults = this.extractInitializeDefaults(request);
		this.defaultModeId = initDefaults.modeId ?? getEnvDefaultMode();
		this.defaultModelId = initDefaults.modelId ?? getEnvDefaultModel();
		this.defaultThinkingLevel = initDefaults.thinkingLevel ?? getEnvDefaultThinking();
		this.defaultFastValue = initDefaults.fastValue;

		const authMethod: NonNullable<InitializeResponse["authMethods"]>[number] = {
			id: "cursor_login",
			name: "Cursor Login",
			description: "Authenticate the Cursor SDK in your browser",
		};
		const authMethods: NonNullable<InitializeResponse["authMethods"]> = [authMethod];
		if (request.clientCapabilities?.auth?.terminal === true) {
			authMethods.unshift({
				type: "terminal",
				id: "cursor_sdk_login",
				name: "Cursor SDK Login",
				description: "Open an interactive browser login for the Cursor SDK",
				args: ["login"],
			});
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
					},
					fork: {},
					resume: {},
					list: {},
				},
			},
			agentInfo: {
				name: packageJson.name,
				title: "Cursor SDK",
				version: packageJson.version,
			},
			authMethods,
		};
	}

	async newSession(params: NewSessionRequest): Promise<ExtendedNewSessionResponse> {
		const sessionId = randomUUID();
		return await this.createSession({
			sessionId,
			cwd: params.cwd,
			mcpServers: params.mcpServers,
			preferredModeId: this.extractRequestedInitialMode(params),
			preferredModelId: this.extractRequestedInitialModel(params),
			preferredThinkingLevel: this.extractRequestedInitialThinking(params),
			preferredFastValue: this.extractRequestedInitialFast(params),
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
		const filePath = await findSessionFile(params.sessionId, params.cwd);
		const meta = filePath ? await readSessionMeta(filePath) : {};
		const response = await this.createSession({
			sessionId: params.sessionId,
			cwd: params.cwd,
			mcpServers: params.mcpServers,
			preferredModeId: meta.modeId,
			preferredModelId: meta.modelId,
			preferredThinkingLevel: meta.thinkingLevel,
			preferredFastValue: meta.fastValue,
			preferredBackendSessionId: meta.backendSessionId,
		});

		const session = this.requireSession(params.sessionId);

		return await this.withDeferredSessionNotifications(session, async () => {
			const notificationStartIndex = session.pendingNotifications.length;
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
		models?: LegacySessionModels;
		configOptions?: NewSessionResponse["configOptions"];
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
				configOptions: response.configOptions,
			};
		}

		const meta = await readSessionMeta(filePath);
		const response = await this.createSession({
			sessionId: params.sessionId,
			cwd: params.cwd,
			mcpServers: params.mcpServers,
			preferredModeId: meta.modeId,
			preferredModelId: meta.modelId,
			preferredThinkingLevel: meta.thinkingLevel,
			preferredFastValue: meta.fastValue,
			preferredBackendSessionId: meta.backendSessionId,
		});

		const session = this.requireSession(params.sessionId);

		return await this.withDeferredSessionNotifications(session, async () => {
			const notificationStartIndex = session.pendingNotifications.length;
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
				configOptions: this.buildConfigOptions(
					session,
					session.nativeSessionModels ?? response.models,
				),
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
		let promptText = promptToCursorText(params);
		const promptImages = promptToCursorImages(params);

		const slash = parseLeadingSlashCommand(promptText);
		if (slash.hasSlash) {
			if (!this.hasNativeSlashCommand(session, slash.command)) {
				const handled = await handleSlashCommand(slash.command, slash.args, {
					session,
					auth: this.auth,
					listModels: async () => await this.runner.listModels(),
					availableCommands: this.availableCommandsForSession(session),
					onModeChanged: async (modeId) => {
						await this.applySessionMode(session, modeId);
					},
					onModelChanged: async (modelId) => {
						session.modelId = modelId;
						session.configuredModelId = modelId;
						this.syncModelParameters(session);
						await this.applyNativeModelIfConnected(session);
						await this.persistSessionMeta(session);
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

				const customPrompt =
					resolveCustomSlashCommandPrompt(
						slash.command,
						slash.args,
						session.customSlashCommands,
					) ?? resolveSkillSlashCommandPrompt(slash.command, session.customSkills);
				if (customPrompt) {
					promptText = customPrompt;
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
		const firstAttempt = await this.runPromptAttempt(session, promptText, promptImages, false);

		if (firstAttempt.stopReason === "cancelled" || session.cancelled) {
			return { stopReason: "cancelled" };
		}

		if (
			firstAttempt.stopReason === "end_turn" &&
			(session.modeId === "default" || session.modeId === "auto-review") &&
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
				this.setSessionModeState(session, "yolo");
				await this.persistSessionMeta(session);
				await this.client.sessionUpdate({
					sessionId: session.sessionId,
					update: {
						sessionUpdate: "current_mode_update",
						currentModeId: session.modeId,
					},
				});
			}

			if (approved === "allow_once" || approved === "allow_always") {
				return await this.runPromptAttempt(session, promptText, promptImages, true);
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
		params: LegacySetSessionModelRequest,
	): Promise<LegacySetSessionModelResponse | void> {
		const session = this.requireSession(params.sessionId);
		return await this.withSessionConfigMutation(session, async () => {
			if (session.activePrompt || session.activeRun) {
				throw RequestError.invalidParams("Cannot change model during an active prompt");
			}

			session.modelId = normalizeModelId(params.modelId);
			session.configuredModelId = session.modelId;
			this.syncModelParameters(session);
			await this.applyNativeModelIfConnected(session);
			await this.persistSessionMeta(session);
			return {};
		});
	}

	async setSessionConfigOption(
		params: SetSessionConfigOptionRequest,
	): Promise<SetSessionConfigOptionResponse> {
		const session = this.requireSession(params.sessionId);
		const value =
			params.configId === FAST_PARAM_ID && typeof params.value === "boolean"
				? String(params.value)
				: params.value;
		if (typeof value !== "string") {
			throw RequestError.invalidParams(
				`Invalid value for config option ${params.configId}: ${String(params.value)}`,
			);
		}

		const response = await this.withSessionConfigMutation(session, async () => {
			return await this.setSessionConfigOptionLocked(session, params.configId, value);
		});
		await this.emitOrQueueNotification(session, {
			sessionId: session.sessionId,
			update: {
				sessionUpdate: "config_option_update",
				configOptions: response.configOptions,
			},
		});
		return response;
	}

	private async setSessionConfigOptionLocked(
		session: SessionState,
		configId: string,
		value: string,
	): Promise<SetSessionConfigOptionResponse> {
		if (configId === "mode") {
			const modeId = normalizeModeId(value);
			if (!modeId) {
				throw RequestError.invalidParams(`Invalid mode: ${value}`);
			}
			await this.applySessionMode(session, modeId);
			return { configOptions: this.buildConfigOptions(session) };
		}

		if (configId === "model") {
			if (session.activePrompt || session.activeRun) {
				throw RequestError.invalidParams("Cannot change model during an active prompt");
			}
			session.modelId = normalizeModelId(value);
			session.configuredModelId = session.modelId;
			this.syncModelParameters(session);
			await this.applyNativeModelIfConnected(session);
			await this.persistSessionMeta(session);
			return { configOptions: this.buildConfigOptions(session) };
		}

		if (configId === FAST_PARAM_ID) {
			if (session.activePrompt || session.activeRun) {
				throw RequestError.invalidParams("Cannot change fast mode during an active prompt");
			}
			const fastParameter = getFastParameterForModel(session.modelCatalog, session.modelId);
			if (!fastParameter) {
				throw RequestError.invalidParams(
					"Fast mode is not supported for the current model",
				);
			}
			if (!fastParameter.values.some((option) => option.value === value)) {
				throw RequestError.invalidParams(`Invalid fast mode: ${value}`);
			}
			const nextModelId = applyFastValue(session.modelCatalog, session.modelId, value);
			if (!nextModelId) {
				throw RequestError.invalidParams(`No model variant for fast mode: ${value}`);
			}
			session.modelId = nextModelId;
			session.configuredModelId = nextModelId;
			session.fastValue = value;
			session.configuredFastValue = value;
			this.syncModelParameters(session);
			await this.applyNativeModelIfConnected(session);
			await this.persistSessionMeta(session);
			return { configOptions: this.buildConfigOptions(session) };
		}

		if (configId === THINKING_PARAM_ID) {
			if (session.activePrompt || session.activeRun) {
				throw RequestError.invalidParams(
					"Cannot change thinking level during an active prompt",
				);
			}
			const parameterModel = findParameterModelInCatalog(
				session.modelCatalog,
				session.modelId,
			);
			if (!getThinkingParameterForModel(session.modelCatalog, session.modelId)) {
				throw RequestError.invalidParams(
					"Thinking level is not supported for the current model",
				);
			}
			if (!isValidThinkingLevel(parameterModel, value)) {
				throw RequestError.invalidParams(`Invalid thinking level: ${value}`);
			}
			const nextModelId = applyThinkingValue(session.modelCatalog, session.modelId, value);
			if (!nextModelId) {
				throw RequestError.invalidParams(`No model variant for thinking level: ${value}`);
			}
			session.modelId = nextModelId;
			session.configuredModelId = nextModelId;
			session.thinkingLevel = value;
			session.configuredThinkingLevel = value;
			this.syncModelParameters(session);
			await this.applyNativeModelIfConnected(session);
			await this.persistSessionMeta(session);
			return { configOptions: this.buildConfigOptions(session) };
		}

		throw RequestError.invalidParams(`Unknown config option: ${configId}`);
	}

	private async withSessionConfigMutation<T>(
		session: SessionState,
		work: () => Promise<T>,
	): Promise<T> {
		const previous = session.configMutationPromise ?? Promise.resolve();
		const current = previous.catch(() => {}).then(work);
		const drain = current.then(
			() => {},
			() => {},
		);
		session.configMutationPromise = drain;

		try {
			return await current;
		} finally {
			if (session.configMutationPromise === drain) {
				session.configMutationPromise = undefined;
			}
		}
	}

	private async applyNativeModelIfConnected(session: SessionState): Promise<void> {
		if (!session.nativeClient?.alive || !session.backendSessionId || !session.modelId) {
			return;
		}
		if (session.nativeModelId === session.modelId) {
			return;
		}

		try {
			await session.nativeClient.setNativeModel(session.modelId);
			session.nativeModelId = session.modelId;
			if (session.nativeSessionModels) {
				session.nativeSessionModels.currentModelId = session.modelId;
			}
			if (session.fallbackSessionModels) {
				session.fallbackSessionModels.currentModelId = session.modelId;
			}
		} catch (error) {
			session.nativeModelId = undefined;
			this.logger.warn?.(
				"[cursor-acp] Native ACP did not accept model update; will apply on next prompt",
				error,
			);
		}
	}

	async extMethod(
		method: string,
		params: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		if (method === "session/set_model") {
			const response = await this.unstable_setSessionModel(
				params as unknown as LegacySetSessionModelRequest,
			);
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
		preferredThinkingLevel?: string;
		preferredFastValue?: string;
		preferredBackendSessionId?: string;
		warmNativeBackend?: boolean;
	}): Promise<ExtendedNewSessionResponse> {
		const modeId = params.preferredModeId ?? this.defaultModeId ?? DEFAULT_MODE_ID;
		const configuredModelId = params.preferredModelId ?? this.defaultModelId;
		const configuredThinkingLevel = params.preferredThinkingLevel ?? this.defaultThinkingLevel;
		const configuredFastValue = params.preferredFastValue ?? this.defaultFastValue;
		const session: SessionState = {
			sessionId: params.sessionId,
			cwd: params.cwd,
			mcpServers: params.mcpServers,
			modeId,
			modelId: configuredModelId,
			configuredModelId,
			configuredThinkingLevel,
			configuredFastValue,
			lastAgentModeId: isAgentSessionMode(modeId) ? modeId : "auto-review",
			cancelled: false,
			nativeAvailableCommands: [],
			customSlashCommands: [],
			customSkills: [],
			notificationsReady: false,
			pendingNotifications: [],
			pendingNativeSessionId: params.preferredBackendSessionId,
		};

		this.sessions[session.sessionId] = session;

		await this.loadSessionSlashExtensions(session);
		const fallbackModels = await this.getAvailableModels(session);
		session.fallbackSessionModels = fallbackModels;
		await this.emitOrQueueNotification(session, {
			sessionId: session.sessionId,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands: this.availableCommandsForSession(session),
			},
		});
		if (params.warmNativeBackend) {
			this.startNativeBackendWarmup(session);
		}
		session.notificationsReady = true;
		setTimeout(() => {
			void this.flushPendingNotifications(session);
		}, 0);

		return {
			sessionId: session.sessionId,
			models: session.nativeSessionModels ?? fallbackModels,
			modes: availableModes(session.modeId),
			configOptions: this.buildConfigOptions(
				session,
				session.nativeSessionModels ?? fallbackModels,
			),
		};
	}

	private async loadSessionSlashExtensions(session: SessionState): Promise<void> {
		const [customSlashCommands, customSkills] = await Promise.allSettled([
			loadCustomSlashCommands(session.cwd),
			loadCustomSkills(session.cwd),
		]);

		if (customSlashCommands.status === "fulfilled") {
			session.customSlashCommands = customSlashCommands.value;
		} else {
			this.logger.warn?.(
				"[cursor-acp] Unable to load custom slash commands",
				customSlashCommands.reason,
			);
		}

		if (customSkills.status === "fulfilled") {
			session.customSkills = customSkills.value;
		} else {
			this.logger.warn?.("[cursor-acp] Unable to load custom skills", customSkills.reason);
		}
	}

	private startNativeBackendWarmup(session: SessionState): void {
		if (session.nativeClient?.alive || session.nativeStartPromise) {
			return;
		}

		session.nativeStartPromise = this.maybeWarmNativeBackendOnSessionCreate(session).finally(
			() => {
				session.nativeStartPromise = undefined;
			},
		);
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
		return pickNormalizedModeId(...modeCandidatesFrom(looseSessionDefaults(params)));
	}

	private extractRequestedInitialModel(params: NewSessionRequest): string | undefined {
		return pickNormalizedModelId(...modelCandidatesFrom(looseSessionDefaults(params)));
	}

	private extractRequestedInitialThinking(params: NewSessionRequest): string | undefined {
		return pickParameterValue(...thinkingCandidatesFrom(looseSessionDefaults(params)));
	}

	private extractRequestedInitialFast(params: NewSessionRequest): string | undefined {
		return pickParameterValue(...fastCandidatesFrom(looseSessionDefaults(params)));
	}

	private extractInitializeDefaults(request: InitializeRequest): {
		modeId?: SessionModeId;
		modelId?: string;
		thinkingLevel?: string;
		fastValue?: string;
	} {
		const raw = request as ExtendedInitializeRequest;

		return {
			modeId: pickNormalizedModeId(
				...modeCandidatesFrom(raw),
				...modeCandidatesFrom(raw.clientCapabilities?._meta ?? {}),
			),
			modelId: pickNormalizedModelId(
				...modelCandidatesFrom(raw),
				...modelCandidatesFrom(raw.clientCapabilities?._meta ?? {}),
			),
			thinkingLevel: pickParameterValue(
				...thinkingCandidatesFrom(raw),
				...thinkingCandidatesFrom(raw.clientCapabilities?._meta ?? {}),
			),
			fastValue: pickParameterValue(
				...fastCandidatesFrom(raw),
				...fastCandidatesFrom(raw.clientCapabilities?._meta ?? {}),
			),
		};
	}

	private async createBackend(
		session: SessionState,
		options?: { loadNativeSessionId?: string },
	): Promise<void> {
		const requestedModelId = session.modelId;
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
						session.nativeModelId = undefined;
					}
					this.logger.error("[cursor-acp] native ACP backend closed", error);
				},
			},
		);

		session.nativeClient = nativeClient;

		const loadId = options?.loadNativeSessionId ?? session.pendingNativeSessionId;

		if (loadId) {
			try {
				const loaded = await nativeClient.loadSessionBackend(loadId);
				if (!this.isCurrentNativeClient(session, nativeClient)) {
					await nativeClient.close();
					return;
				}
				session.backendSessionId = loadId;
				session.pendingNativeSessionId = undefined;
				session.nativeModelId = requestedModelId;
				await this.applyNativeSessionModelsAndModes(session, loaded);
				session.nativeLoadSucceeded = true;
			} catch (error) {
				if (!this.isCurrentNativeClient(session, nativeClient)) {
					return;
				}
				this.logger.warn?.(
					"[cursor-acp] Native session/load failed; starting a new native session",
					error,
				);
				session.nativeLoadSucceeded = false;
				const response = await nativeClient.createSessionBackend();
				if (!this.isCurrentNativeClient(session, nativeClient)) {
					await nativeClient.close();
					return;
				}
				session.backendSessionId = response.sessionId;
				session.pendingNativeSessionId = undefined;
				session.nativeModelId = requestedModelId;
				await this.applyNativeSessionModelsAndModes(session, response);
			}
		} else {
			const response = await nativeClient.createSessionBackend();
			if (!this.isCurrentNativeClient(session, nativeClient)) {
				await nativeClient.close();
				return;
			}
			session.backendSessionId = response.sessionId;
			session.pendingNativeSessionId = undefined;
			session.nativeModelId = requestedModelId;
			await this.applyNativeSessionModelsAndModes(session, response);
		}

		try {
			await this.persistSessionMeta(session);
		} catch (error) {
			this.logger.error("[cursor-acp] Failed to record session meta", error);
		}

		await this.applyNativeModeAfterConnect(session, nativeClient);
	}

	private isCurrentNativeClient(
		session: SessionState,
		nativeClient: NativeSessionBackend,
	): boolean {
		return session.nativeClient === nativeClient && nativeClient.alive;
	}

	private async applyNativeSessionModelsAndModes(
		session: SessionState,
		loaded: {
			models?: LegacySessionModels;
			modes?: NewSessionResponse["modes"];
		},
	): Promise<void> {
		if (loaded.models) {
			let listedModels: CursorModelDescriptor[] = [];
			try {
				listedModels = await this.runner.listModels();
			} catch (error) {
				this.logger.warn?.("[cursor-acp] Unable to refresh the full model list", error);
			}

			const modelCatalog = withCliModelParameters(
				mergeModelCatalogs(
					listedModels.length > 0
						? listedModels
						: loaded.models.availableModels.map((model) => ({
								modelId: normalizeModelId(model.modelId),
								name: model.name,
								current: loaded.models?.currentModelId === model.modelId,
							})),
					session.modelCatalog,
				),
			);
			session.modelCatalog = modelCatalog;

			const availableModels =
				modelCatalog.length > 0
					? modelCatalog.map((model) => ({
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

			const resolvedConfiguredModelId = resolveModelId(
				session.configuredModelId,
				modelCatalog,
			);
			if (resolvedConfiguredModelId) {
				session.configuredModelId = resolvedConfiguredModelId;
			}
			const resolvedSessionModelId = resolveModelId(session.modelId, modelCatalog);
			const resolvedNativeCurrentModelId = resolveModelId(
				loaded.models.currentModelId,
				modelCatalog,
			);

			const currentModelId =
				resolvedConfiguredModelId ??
				resolvedNativeCurrentModelId ??
				modelCatalog.find((model) => model.current)?.modelId ??
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
			this.syncModelParameters(session);
			if (session.nativeSessionModels && session.modelId) {
				session.nativeSessionModels.currentModelId = session.modelId;
			}
		}

		if (loaded.modes?.currentModeId) {
			if (
				loaded.modes.currentModeId !== "agent" ||
				(session.modeId !== "ask" && session.modeId !== "plan")
			) {
				const translated = this.translateNativeMode(session, loaded.modes.currentModeId);
				session.modeId = translated;
				if (isAgentSessionMode(translated)) {
					session.lastAgentModeId = translated;
				}
			}
		}
	}

	private async applyNativeModeAfterConnect(
		session: SessionState,
		nativeClient: NativeSessionBackend,
	): Promise<void> {
		if (session.modeId === "ask" || session.modeId === "plan") {
			const nativeMode = this.modeToNativeMode(session.modeId);
			if (session.appliedNativeModeId === nativeMode) {
				return;
			}
			await nativeClient.setNativeMode(nativeMode);
			session.appliedNativeModeId = nativeMode;
		}
	}

	private buildResumeResponse(
		session: SessionState,
		fallback: ExtendedNewSessionResponse,
	): ExtendedResumeSessionResponse {
		const models = session.nativeSessionModels ?? fallback.models;
		return {
			models,
			modes: availableModes(session.modeId),
			configOptions: this.buildConfigOptions(session, models),
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
		if (session.nativeStartPromise) {
			await session.nativeStartPromise;
			if (session.nativeClient?.alive) {
				if (!session.modelId || session.nativeModelId === session.modelId) {
					return;
				}
				await this.applyNativeModelIfConnected(session);
				return;
			}
		}

		if (session.nativeClient?.alive) {
			if (session.modelId && session.nativeModelId !== session.modelId) {
				await this.applyNativeModelIfConnected(session);
			}
			return;
		}

		await this.createBackend(session, {
			loadNativeSessionId: session.pendingNativeSessionId,
		});
	}

	private async restartBackend(session: SessionState): Promise<void> {
		if (session.activePrompt) {
			throw RequestError.invalidParams("Cannot restart backend during an active prompt");
		}

		session.nativeStartPromise = undefined;
		await session.nativeClient?.close();
		session.nativeClient = undefined;
		session.backendSessionId = undefined;
		session.nativeModelId = undefined;
		await this.createBackend(session);
	}

	private async getAvailableModels(session: SessionState) {
		let listed: CursorModelDescriptor[] = [];
		try {
			listed = await this.runner.listModels();
		} catch (error) {
			this.logger.error("[cursor-acp] Unable to list models", error);
		}

		listed = withCliModelParameters(mergeModelCatalogs(listed, session.modelCatalog));
		session.modelCatalog = listed;

		const configuredModelId = resolveModelId(session.configuredModelId, listed);
		if (configuredModelId) {
			session.configuredModelId = configuredModelId;
			session.modelId = configuredModelId;
		} else {
			session.modelId = resolveModelId(session.modelId, listed);
		}

		const availableModels = listed.map((model) => ({
			modelId: model.modelId,
			name: model.name,
			description: this.modelHoverDescription(model.modelId, model.name),
		}));

		const hasSelectedModel =
			typeof session.modelId === "string" &&
			listed.some((model) => model.modelId === session.modelId);
		if (!hasSelectedModel && !configuredModelId) {
			session.modelId = listed.find((model) => model.current)?.modelId ?? listed[0]?.modelId;
		}

		this.syncModelParameters(session);

		return {
			availableModels,
			currentModelId: session.modelId ?? "auto",
		};
	}

	private buildConfigOptions(
		session: SessionState,
		models: LegacySessionModels | undefined = session.nativeSessionModels ??
			session.fallbackSessionModels,
	): SessionConfigOption[] {
		const modeState = availableModes(session.modeId);
		const configOptions: SessionConfigOption[] = [
			{
				id: "mode",
				name: "Mode",
				description: "Session mode",
				category: "mode",
				type: "select",
				currentValue: modeState.currentModeId,
				options: modeState.availableModes.map((mode) => ({
					value: mode.id,
					name: mode.name,
					description: mode.description,
				})),
			},
		];

		if (models) {
			configOptions.push({
				id: "model",
				name: "Model",
				description: "AI model to use",
				category: "model",
				type: "select",
				currentValue: session.modelId ?? models.currentModelId,
				options: models.availableModels.map((model) => ({
					value: model.modelId,
					name: model.name,
					description: model.description ?? undefined,
				})),
			});

			const fastParameter = getFastParameterForModel(session.modelCatalog, session.modelId);
			if (fastParameter && session.fastValue) {
				const common = {
					id: FAST_PARAM_ID,
					name: fastParameter.displayName ?? "Fast",
					description: "Fast response variant for the selected model",
					category: "model_config",
				} as const;
				if (this.clientCapabilities?.session?.configOptions?.boolean != null) {
					configOptions.push({
						...common,
						type: "boolean",
						currentValue: session.fastValue === "true",
					});
				} else {
					configOptions.push({
						...common,
						type: "select",
						currentValue: session.fastValue,
						options: fastParameter.values.map((value) => ({
							value: value.value,
							name: formatFastParameterOptionName(value.value, value.displayName),
						})),
					});
				}
			}

			const thinkingParameter = getThinkingParameterForModel(
				session.modelCatalog,
				session.modelId,
			);
			if (thinkingParameter && session.thinkingLevel) {
				configOptions.push({
					id: THINKING_PARAM_ID,
					name: thinkingParameter.displayName ?? "Thinking",
					description: "Thinking or reasoning level for the selected model",
					category: "thought_level",
					type: "select",
					currentValue: session.thinkingLevel,
					options: thinkingParameter.values.map((value) => ({
						value: value.value,
						name: value.displayName ?? value.value,
					})),
				});
			}
		}

		return configOptions;
	}

	private syncModelParameters(session: SessionState): void {
		this.syncFastValueForModel(session);

		let nextModelId = session.modelId;
		if (session.configuredFastValue) {
			nextModelId =
				applyFastValue(session.modelCatalog, nextModelId, session.configuredFastValue) ??
				nextModelId;
		}
		if (session.configuredThinkingLevel) {
			nextModelId =
				applyThinkingValue(
					session.modelCatalog,
					nextModelId,
					session.configuredThinkingLevel,
				) ?? nextModelId;
		}
		if (nextModelId && nextModelId !== session.modelId) {
			session.modelId = nextModelId;
			session.configuredModelId = nextModelId;
		}
		this.syncFastValueForModel(session);
		this.syncThinkingLevelForModel(session);
	}

	private syncThinkingLevelForModel(session: SessionState): void {
		const parameterModel = findParameterModelInCatalog(session.modelCatalog, session.modelId);
		const thinkingParameter = getThinkingParameterForModel(
			session.modelCatalog,
			session.modelId,
		);
		if (!thinkingParameter) {
			session.thinkingLevel = undefined;
			return;
		}

		const inferred = inferThinkingValueFromModelId(session.modelCatalog, session.modelId);
		const resolved = isValidThinkingLevel(parameterModel, session.configuredThinkingLevel)
			? session.configuredThinkingLevel
			: ((inferred && isValidThinkingLevel(parameterModel, inferred)
					? inferred
					: undefined) ?? resolveDefaultThinkingLevel(parameterModel));
		session.thinkingLevel = resolved;
		if (
			session.configuredThinkingLevel &&
			!isValidThinkingLevel(parameterModel, session.configuredThinkingLevel)
		) {
			session.configuredThinkingLevel = resolved;
		}
	}

	private syncFastValueForModel(session: SessionState): void {
		const parameterModel = findParameterModelInCatalog(session.modelCatalog, session.modelId);
		const fastParameter = getFastParameterForModel(session.modelCatalog, session.modelId);
		if (!fastParameter) {
			session.fastValue = undefined;
			return;
		}

		const inferred = inferFastValueFromModelId(session.modelCatalog, session.modelId);
		const resolved =
			parameterModel && isValidFastValue(parameterModel, session.configuredFastValue)
				? session.configuredFastValue
				: ((inferred && fastParameter.values.some((value) => value.value === inferred)
						? inferred
						: undefined) ?? resolveDefaultFastValue(parameterModel));
		session.fastValue = resolved;
		if (
			session.configuredFastValue &&
			parameterModel &&
			!isValidFastValue(parameterModel, session.configuredFastValue)
		) {
			session.configuredFastValue = resolved;
		}
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
		reviewPolicy: "auto-review" | "run-everything";
	} {
		if (forceRetry) {
			return { reviewPolicy: "run-everything" };
		}

		switch (session.modeId) {
			case "plan":
				return { modeId: "plan", reviewPolicy: "auto-review" };
			case "ask":
				return { modeId: "ask", reviewPolicy: "auto-review" };
			case "yolo":
				return { reviewPolicy: "run-everything" };
			case "auto-review":
				return { reviewPolicy: "auto-review" };
			case "default":
				return { reviewPolicy: "auto-review" };
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
			await this.persistSessionMeta(session);
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
		images: RunPromptOptions["images"],
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
			images,
			modelId: session.modelId,
			modeId: modeSettings.modeId,
			reviewPolicy: modeSettings.reviewPolicy,
			modelCatalog: session.modelCatalog,
			thinkingLevel: session.thinkingLevel,
			fastValue: session.fastValue,
			mcpServers: session.mcpServers,
			onEvent: async (event) => {
				const mapped = mapCursorEventToAcp(event, {
					sessionId: session.sessionId,
					toolUseCache,
					logger: this.logger,
				});

				if (mapped.backendSessionId) {
					session.backendSessionId = mapped.backendSessionId;
					await this.persistSessionMeta(session);
				}

				if (mapped.currentModeId) {
					const translated = normalizeModeId(mapped.currentModeId);
					if (translated) {
						this.setSessionModeState(session, translated);
						await this.persistSessionMeta(session);
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
				throw RequestError.internalError(undefined, "Cursor did not emit a result event");
			}

			const subtype = typeof resultEvent.subtype === "string" ? resultEvent.subtype : "";
			const isError = resultEvent.is_error === true;
			if (isError && rejectedToolCalls.length > 0) {
				return { stopReason: "end_turn", rejectedToolCalls };
			}

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
			throw RequestError.internalError(undefined, resultText || "Cursor failed");
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
			this.setSessionModeState(session, translatedMode);
			await this.persistSessionMeta(session);
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
					availableCommands: this.availableCommandsForSession(session),
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

	private availableCommandsForSession(session: SessionState): AvailableCommand[] {
		return mergeAvailableSlashCommands(
			session.nativeAvailableCommands,
			session.customSlashCommands,
			session.customSkills,
		);
	}

	/**
	 * Native `cursor-agent acp` uses the backend session id in payloads; the outer ACP client
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
			toolCall: normalizePermissionToolCallTitle(request.toolCall),
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
			case "auto-review":
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
		const canSetNativeMode =
			session.nativeClient?.alive &&
			!(session.nativeStartPromise && !session.backendSessionId);

		if (canSetNativeMode) {
			const nativeMode = this.modeToNativeMode(modeId);
			await session.nativeClient!.setNativeMode(nativeMode);
			session.appliedNativeModeId = nativeMode;
		}

		this.setSessionModeState(session, modeId);
		await this.persistSessionMeta(session);
	}

	private setSessionModeState(session: SessionState, modeId: SessionModeId): void {
		session.modeId = modeId;
		if (isAgentSessionMode(modeId)) {
			session.lastAgentModeId = modeId;
		}
	}

	private async persistSessionMeta(session: SessionState): Promise<void> {
		await recordSessionMeta(session.cwd, session.sessionId, {
			backendSessionId: session.backendSessionId,
			modeId: session.modeId,
			modelId: session.configuredModelId ?? session.modelId,
			thinkingLevel: session.configuredThinkingLevel ?? session.thinkingLevel,
			fastValue: session.configuredFastValue ?? session.fastValue,
		});
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
	client: CursorAcpClient,
	notification: SessionNotification,
): Promise<void> {
	return client.sessionUpdate(notification);
}
