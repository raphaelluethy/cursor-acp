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
	WriteTextFileRequest,
	WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import packageJson from "../package.json" with { type: "json" };
import { CursorAuth, CursorAuthClient } from "./auth.js";
import {
	CreateNativeSessionOptions,
	CursorNativeAcpClient,
	NativeModeId,
	NativeSessionBackend,
	NativeSessionCallbacks,
} from "./cursor-native-acp-client.js";
import { CursorCliRunner } from "./cursor-cli-runner.js";
import { parseLeadingSlashCommand, promptToCursorText } from "./prompt-conversion.js";
import {
	availableSlashCommands,
	CursorModelDescriptor,
	handleSlashCommand,
} from "./slash-commands.js";
import {
	availableModes,
	DEFAULT_MODE_ID,
	normalizeModeId,
	parseDefaultMode,
	parseDefaultModel,
	SessionModeId,
} from "./settings.js";
import {
	findSessionFile,
	listSessions,
	recordAssistantMessage,
	recordSessionMeta,
	recordUserMessage,
	replaySessionHistory,
} from "./session-storage.js";
import { Logger } from "./utils.js";

interface ActivePromptState {
	assistantTextChunks: string[];
}

interface SessionState {
	sessionId: string;
	cwd: string;
	mcpServers?: NewSessionRequest["mcpServers"];
	modeId: SessionModeId;
	modelId?: string;
	lastAgentModeId: "default" | "autoRunAllCommands";
	cancelled: boolean;
	activePrompt?: ActivePromptState;
	backendSessionId?: string;
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

		const filePath = await findSessionFile(params.sessionId, params.cwd);
		if (filePath) {
			await replaySessionHistory({
				sessionId: params.sessionId,
				filePath,
				sendNotification: async (notification) => {
					await this.client.sessionUpdate(notification);
				},
			});
		}

		return response;
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

		await replaySessionHistory({
			sessionId: params.sessionId,
			filePath,
			sendNotification: async (notification) => {
				await this.client.sessionUpdate(notification);
			},
		});

		return {
			modes: response.modes,
			models: response.models,
		};
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

		session.cancelled = false;
		await recordUserMessage(session.cwd, session.sessionId, promptText);

		await this.ensureBackend(session);
		session.activePrompt = { assistantTextChunks: [] };

		try {
			const result = await session.nativeClient!.prompt(promptText);

			if (session.cancelled) {
				return { stopReason: "cancelled" };
			}

			if (
				result.stopReason === "end_turn" &&
				session.activePrompt.assistantTextChunks.length > 0
			) {
				await recordAssistantMessage(
					session.cwd,
					session.sessionId,
					session.activePrompt.assistantTextChunks.join(""),
				);
			}

			return result;
		} catch (error) {
			if (session.cancelled) {
				return { stopReason: "cancelled" };
			}

			if (error instanceof RequestError) {
				throw error;
			}

			throw RequestError.internalError(undefined, String(error));
		} finally {
			session.activePrompt = undefined;
		}
	}

	async cancel(params: CancelNotification): Promise<void> {
		const session = this.requireSession(params.sessionId);
		session.cancelled = true;
		await session.nativeClient?.cancel();
	}

	async unstable_setSessionModel(
		params: SetSessionModelRequest,
	): Promise<SetSessionModelResponse | void> {
		const session = this.requireSession(params.sessionId);
		if (session.activePrompt) {
			throw RequestError.invalidParams("Cannot change model during an active prompt");
		}

		session.modelId = params.modelId;
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
	}): Promise<NewSessionResponse> {
		const modeId = parseDefaultMode() ?? DEFAULT_MODE_ID;
		const session: SessionState = {
			sessionId: params.sessionId,
			cwd: params.cwd,
			mcpServers: params.mcpServers,
			modeId,
			modelId: parseDefaultModel(),
			lastAgentModeId: modeId === "autoRunAllCommands" ? "autoRunAllCommands" : "default",
			cancelled: false,
			nativeAvailableCommands: [],
			notificationsReady: false,
			pendingNotifications: [],
		};

		this.sessions[session.sessionId] = session;

		const models = await this.getAvailableModels(session);
		session.notificationsReady = true;
		setTimeout(() => {
			void this.flushPendingNotifications(session);
		}, 0);

		return {
			sessionId: session.sessionId,
			models,
			modes: availableModes(session.modeId),
		};
	}

	private async createBackend(session: SessionState): Promise<void> {
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
		const response = await nativeClient.createSessionBackend();
		session.backendSessionId = response.sessionId;

		try {
			await recordSessionMeta(session.cwd, session.sessionId, session.backendSessionId);
		} catch (error) {
			this.logger.error("[cursor-acp] Failed to record session meta", error);
		}

		if (session.modeId === "ask" || session.modeId === "plan") {
			await nativeClient.setNativeMode(this.modeToNativeMode(session.modeId));
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

		const availableModels = listed.map((model) => ({
			modelId: model.modelId,
			name: model.name,
			description: model.name,
		}));

		if (!session.modelId) {
			session.modelId = listed.find((model) => model.current)?.modelId ?? listed[0]?.modelId;
		}

		return {
			availableModels,
			currentModelId: session.modelId,
		};
	}

	private async handleNativeSessionUpdate(
		session: SessionState,
		notification: SessionNotification,
	): Promise<void> {
		const update = notification.update;

		if (
			update.sessionUpdate === "agent_message_chunk" &&
			update.content?.type === "text" &&
			session.activePrompt
		) {
			session.activePrompt.assistantTextChunks.push(update.content.text);
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
		const normalized = commandName.toLowerCase();
		return session.nativeAvailableCommands.some(
			(command) => command.name.toLowerCase() === normalized,
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

		if (session.modeId === "autoRunAllCommands") {
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
			case "autoRunAllCommands":
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
		if (modeId === "default" || modeId === "autoRunAllCommands") {
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
