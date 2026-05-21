import {
	Agent,
	AuthenticateRequest,
	AvailableCommand,
	CancelNotification,
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
	ResumeSessionRequest,
	ResumeSessionResponse,
	SetSessionModelRequest,
	SetSessionModelResponse,
	SetSessionModeRequest,
	SetSessionModeResponse,
	SetSessionConfigOptionRequest,
	SetSessionConfigOptionResponse,
	SessionConfigOption,
	SessionNotification,
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
import { createCursorAuth, CursorAuthClient } from "./auth.js";
import type { CursorAcpClient } from "./cursor-acp-client.js";
import { CachedToolUse, mapCursorEventToAcp, RejectedToolCall } from "./cursor-event-mapper.js";
import type { CursorRunner } from "./cursor-runner.js";
import { createCursorRunner } from "./cursor-runner-provider.js";
import {
	FAST_PARAM_ID,
	ensureAutoModel,
	formatFastParameterOptionName,
	getFastParameter,
	getThoughtLevelParameter,
	isThoughtLevelParamId,
	isValidFastValue,
	isValidThoughtLevel,
	normalizeModelId,
	resolveFastParameterModel,
	resolveFastValue,
	resolveModelId,
	resolveParameterModel,
	resolveThoughtLevel,
} from "./model-id.js";
import { parseLeadingSlashCommand, promptToCursorText } from "./prompt-conversion.js";
import {
	availableSlashCommands,
	CursorModelDescriptor,
	handleSlashCommand,
} from "./slash-commands.js";
import {
	availableModes,
	DEFAULT_MODE_ID,
	getEnvDefaultMode,
	getEnvDefaultModel,
	getEnvDefaultThinking,
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
import { Logger, unreachable } from "./utils.js";
import * as fs from "node:fs";
import * as path from "node:path";

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

function pickThinkingLevel(...candidates: unknown[]): string | undefined {
	for (const candidate of candidates) {
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

function pickFastValue(...candidates: unknown[]): string | undefined {
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
	thoughtParamId?: string;
	configuredThoughtParamId?: string;
	fastValue?: string;
	configuredFastValue?: string;
	lastAgentModeId: "default" | "yolo";
	cancelled: boolean;
	activeRun?: ActiveRunState;
	backendSessionId?: string;
	availableCommands: AvailableCommand[];
	notificationsReady: boolean;
	pendingNotifications: SessionNotification[];
	models?: NewSessionResponse["models"];
	modelCatalog?: CursorModelDescriptor[];
}

export interface CursorAcpAgentOptions {
	runner?: CursorRunner;
	auth?: CursorAuthClient;
	logger?: Logger;
}

export class CursorAcpAgent implements Agent {
	private readonly sessions: Record<string, SessionState> = {};
	private defaultModeId?: SessionModeId;
	private defaultModelId?: string;
	private defaultThinkingLevel?: string;
	private defaultFastValue?: string;

	private readonly runner: CursorRunner;
	private readonly auth: CursorAuthClient;
	private readonly logger: Logger;

	constructor(
		private readonly client: CursorAcpClient,
		options: CursorAcpAgentOptions = {},
	) {
		this.logger = options.logger ?? console;
		this.runner = options.runner ?? createCursorRunner(this.logger);
		this.auth = options.auth ?? createCursorAuth();
	}

	async initialize(request: InitializeRequest): Promise<InitializeResponse> {
		appendDebugLog("initialize.clientCapabilities", request.clientCapabilities ?? null);

		const initDefaults = this.extractInitializeDefaults(request);
		this.defaultModeId = initDefaults.modeId ?? getEnvDefaultMode();
		this.defaultModelId = initDefaults.modelId ?? getEnvDefaultModel();
		this.defaultThinkingLevel = initDefaults.thinkingLevel ?? getEnvDefaultThinking();
		this.defaultFastValue = initDefaults.fastValue;

		const authMethod: NonNullable<InitializeResponse["authMethods"]>[number] = {
			id: "cursor_login",
			name: "Cursor Login",
			description: "Authenticate using CURSOR_API_KEY (Cursor SDK)",
		};

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
				title: "Cursor",
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
			preferredThinkingLevel: meta.thinkingLevel,
			preferredThoughtParamId: meta.thoughtParamId,
			preferredFastValue: meta.fastValue,
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
		models: NewSessionResponse["models"];
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
			preferredThinkingLevel: meta.thinkingLevel,
			preferredThoughtParamId: meta.thoughtParamId,
			preferredFastValue: meta.fastValue,
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
				models: response.models,
				configOptions: this.buildConfigOptions(session, response.models),
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
			const handled = await handleSlashCommand(slash.command, slash.args, {
				session,
				auth: this.auth,
				listModels: async () => await this.runner.listModels(),
				availableCommands: availableSlashCommands(session.availableCommands),
				onModeChanged: async (modeId) => {
					await this.applySessionMode(session, modeId);
				},
				onModelChanged: async (modelId) => {
					session.modelId = modelId;
					session.configuredModelId = modelId;
					this.syncParametersForModel(session);
					await this.persistSessionMeta(session);
					await this.emitConfigOptionsUpdate(session);
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

		const status = await this.auth.status();
		if (!status.loggedIn) {
			throw RequestError.authRequired();
		}

		if (session.activeRun) {
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
				return await this.runPromptAttempt(session, promptText, true);
			}
		}

		return { stopReason: firstAttempt.stopReason };
	}

	async cancel(params: CancelNotification): Promise<void> {
		const session = this.requireSession(params.sessionId);
		session.cancelled = true;
		session.activeRun?.cancel();
	}

	async unstable_setSessionModel(
		params: SetSessionModelRequest,
	): Promise<SetSessionModelResponse | void> {
		const session = this.requireSession(params.sessionId);
		if (session.activeRun) {
			throw RequestError.invalidParams("Cannot change model during an active prompt");
		}

		session.modelId = normalizeModelId(params.modelId);
		session.configuredModelId = session.modelId;
		this.syncParametersForModel(session);
		await this.persistSessionMeta(session);
		await this.emitConfigOptionsUpdate(session);
		return {};
	}

	async setSessionConfigOption(
		params: SetSessionConfigOptionRequest,
	): Promise<SetSessionConfigOptionResponse> {
		const session = this.requireSession(params.sessionId);
		if (typeof params.value !== "string") {
			throw RequestError.invalidParams(
				`Invalid value for config option ${params.configId}: ${String(params.value)}`,
			);
		}

		if (params.configId === "mode") {
			const modeId = normalizeModeId(params.value);
			if (!modeId) {
				throw RequestError.invalidParams(`Invalid mode: ${params.value}`);
			}
			await this.applySessionMode(session, modeId);
			const configOptions = this.buildConfigOptions(session);
			await this.emitConfigOptionsUpdate(session, configOptions);
			return { configOptions };
		}

		if (params.configId === "model") {
			if (session.activeRun) {
				throw RequestError.invalidParams("Cannot change model during an active prompt");
			}
			session.modelId = normalizeModelId(params.value);
			session.configuredModelId = session.modelId;
			this.syncParametersForModel(session);
			await this.persistSessionMeta(session);
			const configOptions = this.buildConfigOptions(session);
			await this.emitConfigOptionsUpdate(session, configOptions);
			return { configOptions };
		}

		if (params.configId === FAST_PARAM_ID) {
			if (session.activeRun) {
				throw RequestError.invalidParams("Cannot change fast mode during an active prompt");
			}
			const parameterModel = resolveFastParameterModel(session.modelCatalog, session.modelId);
			if (!getFastParameter(parameterModel)) {
				throw RequestError.invalidParams(
					"Fast mode is not supported for the current model",
				);
			}
			if (!isValidFastValue(parameterModel, params.value)) {
				throw RequestError.invalidParams(`Invalid fast mode: ${params.value}`);
			}
			session.fastValue = params.value;
			session.configuredFastValue = params.value;
			await this.persistSessionMeta(session);
			const configOptions = this.buildConfigOptions(session);
			await this.emitConfigOptionsUpdate(session, configOptions);
			return { configOptions };
		}

		if (isThoughtLevelParamId(params.configId)) {
			if (session.activeRun) {
				throw RequestError.invalidParams(
					"Cannot change thinking level during an active prompt",
				);
			}
			const parameterModel = resolveParameterModel(session.modelCatalog, session.modelId);
			const thoughtParameter = getThoughtLevelParameter(parameterModel);
			if (!thoughtParameter || thoughtParameter.id !== params.configId) {
				throw RequestError.invalidParams(
					"Thinking level is not supported for the current model",
				);
			}
			if (!isValidThoughtLevel(parameterModel, params.configId, params.value)) {
				throw RequestError.invalidParams(`Invalid thinking level: ${params.value}`);
			}
			session.thoughtParamId = params.configId;
			session.configuredThoughtParamId = params.configId;
			session.thinkingLevel = params.value;
			session.configuredThinkingLevel = params.value;
			await this.persistSessionMeta(session);
			const configOptions = this.buildConfigOptions(session);
			await this.emitConfigOptionsUpdate(session, configOptions);
			return { configOptions };
		}

		throw RequestError.invalidParams(`Unknown config option: ${params.configId}`);
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
		preferredThinkingLevel?: string;
		preferredThoughtParamId?: string;
		preferredFastValue?: string;
	}): Promise<NewSessionResponse> {
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
			configuredThoughtParamId: params.preferredThoughtParamId,
			configuredFastValue,
			lastAgentModeId: modeId === "yolo" ? "yolo" : "default",
			cancelled: false,
			availableCommands: [],
			notificationsReady: false,
			pendingNotifications: [],
		};

		this.sessions[session.sessionId] = session;

		const fallbackModels = await this.getAvailableModels(session);
		session.notificationsReady = true;
		setTimeout(() => {
			void this.flushPendingNotifications(session);
		}, 0);

		return {
			sessionId: session.sessionId,
			models: fallbackModels,
			modes: availableModes(session.modeId),
			configOptions: this.buildConfigOptions(session, fallbackModels),
		};
	}

	private extractRequestedInitialMode(params: NewSessionRequest): SessionModeId | undefined {
		return pickNormalizedModeId(...modeCandidatesFrom(looseSessionDefaults(params)));
	}

	private extractRequestedInitialModel(params: NewSessionRequest): string | undefined {
		return pickNormalizedModelId(...modelCandidatesFrom(looseSessionDefaults(params)));
	}

	private extractRequestedInitialFast(params: NewSessionRequest): string | undefined {
		return pickFastValue(...fastCandidatesFrom(looseSessionDefaults(params)));
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
			thinkingLevel: pickThinkingLevel(
				...thinkingCandidatesFrom(raw),
				...thinkingCandidatesFrom(raw.clientCapabilities?._meta ?? {}),
			),
			fastValue: pickFastValue(
				...fastCandidatesFrom(raw),
				...fastCandidatesFrom(raw.clientCapabilities?._meta ?? {}),
			),
		};
	}

	private buildResumeResponse(
		session: SessionState,
		fallback: NewSessionResponse,
	): ResumeSessionResponse {
		const models = fallback.models;
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

	private async getAvailableModels(session: SessionState) {
		let listed: CursorModelDescriptor[] = [];
		try {
			listed = await this.runner.listModels();
		} catch (error) {
			this.logger.error("[cursor-acp] Unable to list models", error);
		}

		session.modelCatalog = listed;

		const configuredModelId = resolveModelId(session.configuredModelId, listed);
		if (configuredModelId) {
			session.configuredModelId = configuredModelId;
			session.modelId = configuredModelId;
		} else {
			session.modelId = resolveModelId(session.modelId, listed);
		}

		const availableModels = ensureAutoModel(listed).map((model) => ({
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

		this.syncParametersForModel(session);

		const models = {
			availableModels,
			currentModelId: session.modelId ?? "auto",
		};
		session.models = models;
		return models;
	}

	private buildConfigOptions(
		session: SessionState,
		models?: NewSessionResponse["models"],
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

		const parameterModel = resolveParameterModel(session.modelCatalog, session.modelId);
		const thoughtParameter = getThoughtLevelParameter(parameterModel);
		if (thoughtParameter && session.thinkingLevel) {
			configOptions.push({
				id: thoughtParameter.id,
				name: thoughtParameter.displayName ?? "Thinking",
				description: "Reasoning effort for the selected model",
				category: "thought_level",
				type: "select",
				currentValue: session.thinkingLevel,
				options: thoughtParameter.values.map((value) => ({
					value: value.value,
					name: value.displayName ?? value.value,
				})),
			});
		}

		const fastParameterModel = resolveFastParameterModel(session.modelCatalog, session.modelId);
		const fastParameter = getFastParameter(fastParameterModel);
		if (fastParameter && session.fastValue) {
			configOptions.push({
				id: FAST_PARAM_ID,
				name: fastParameter.displayName ?? "Fast",
				description: "Fast response variant for the selected model",
				category: "model",
				type: "select",
				currentValue: session.fastValue,
				options: fastParameter.values.map((value) => ({
					value: value.value,
					name: formatFastParameterOptionName(value.value, value.displayName),
				})),
			});
		}

		const effectiveModels = models ?? session.models;
		if (effectiveModels) {
			configOptions.push({
				id: "model",
				name: "Model",
				description: "AI model to use",
				category: "model",
				type: "select",
				currentValue: session.modelId ?? effectiveModels.currentModelId,
				options: effectiveModels.availableModels.map((model) => ({
					value: model.modelId,
					name: model.name,
					description: model.description ?? undefined,
				})),
			});
		}

		return configOptions;
	}

	private syncParametersForModel(session: SessionState): void {
		this.syncThinkingLevelForModel(session);
		this.syncFastValueForModel(session);
	}

	private syncThinkingLevelForModel(session: SessionState): void {
		const parameterModel = resolveParameterModel(session.modelCatalog, session.modelId);
		const thoughtParameter = getThoughtLevelParameter(parameterModel);
		if (!thoughtParameter) {
			session.thoughtParamId = undefined;
			session.thinkingLevel = undefined;
			return;
		}

		session.thoughtParamId = thoughtParameter.id;

		const configuredValue =
			session.configuredThoughtParamId === thoughtParameter.id
				? session.configuredThinkingLevel
				: undefined;
		const resolved = resolveThoughtLevel(parameterModel, thoughtParameter.id, configuredValue);
		session.thinkingLevel = resolved;
		if (configuredValue && resolved !== configuredValue) {
			session.configuredThinkingLevel = resolved;
			session.configuredThoughtParamId = thoughtParameter.id;
		}
		if (
			session.configuredThoughtParamId &&
			session.configuredThoughtParamId !== thoughtParameter.id
		) {
			session.configuredThoughtParamId = thoughtParameter.id;
			session.configuredThinkingLevel = resolved;
		}
	}

	private syncFastValueForModel(session: SessionState): void {
		const parameterModel = resolveFastParameterModel(session.modelCatalog, session.modelId);
		if (!getFastParameter(parameterModel)) {
			session.fastValue = undefined;
			return;
		}

		const resolved = resolveFastValue(parameterModel, session.configuredFastValue);
		session.fastValue = resolved;
		if (session.configuredFastValue && resolved !== session.configuredFastValue) {
			session.configuredFastValue = resolved;
		}
	}

	private modelHoverDescription(modelId: string, baseDescription: string): string {
		return `${baseDescription} (id: ${modelId})`;
	}

	private modelDisplayName(_modelId: string, name: string): string {
		return name;
	}

	private modeToRunnerOptions(
		session: SessionState,
		forceRetry: boolean,
	): {
		modeId?: "plan";
		force: boolean;
	} {
		if (forceRetry) {
			return { force: true };
		}

		switch (session.modeId) {
			case "plan":
				return { modeId: "plan", force: false };
			case "yolo":
				return { force: true };
			case "default":
				return { force: false };
			default:
				unreachable(session.modeId, this.logger);
		}
	}

	private async ensureBackendSessionId(session: SessionState): Promise<void> {
		if (session.backendSessionId) {
			return;
		}

		try {
			session.backendSessionId = await this.runner.createChat();
			await this.persistSessionMeta(session);
		} catch (error) {
			this.logger.error(
				"[cursor-acp] SDK chat creation failed, using lazy backend session binding",
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

		await this.ensureBackendSessionId(session);

		const run = this.runner.startPrompt({
			workspace: session.cwd,
			backendSessionId: session.backendSessionId,
			prompt: promptText,
			modelId: session.modelId,
			thinkingLevel: session.thinkingLevel,
			modelCatalog: session.modelCatalog,
			thoughtParamId: session.thoughtParamId,
			fastValue: session.fastValue,
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
				throw RequestError.internalError(
					undefined,
					"Cursor SDK did not emit a result event",
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
			throw RequestError.internalError(undefined, resultText || "Cursor SDK failed");
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

	private async emitConfigOptionsUpdate(
		session: SessionState,
		configOptions = this.buildConfigOptions(session),
	): Promise<void> {
		await this.emitOrQueueNotification(session, {
			sessionId: session.sessionId,
			update: {
				sessionUpdate: "config_option_update",
				configOptions,
			},
		});
	}

	private async applySessionMode(session: SessionState, modeId: SessionModeId): Promise<void> {
		this.setSessionModeState(session, modeId);
		await this.persistSessionMeta(session);
	}

	private setSessionModeState(session: SessionState, modeId: SessionModeId): void {
		session.modeId = modeId;
		if (modeId === "default" || modeId === "yolo") {
			session.lastAgentModeId = modeId;
		}
	}

	private async persistSessionMeta(session: SessionState): Promise<void> {
		await recordSessionMeta(session.cwd, session.sessionId, {
			backendSessionId: session.backendSessionId,
			modeId: session.modeId,
			thinkingLevel: session.configuredThinkingLevel ?? session.thinkingLevel,
			thoughtParamId: session.configuredThoughtParamId ?? session.thoughtParamId,
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
