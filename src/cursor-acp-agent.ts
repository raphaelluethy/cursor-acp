import {
	Agent,
	AgentSideConnection,
	AuthenticateRequest,
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
	ResumeSessionRequest,
	ResumeSessionResponse,
	SessionModelState,
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
import { CursorCliRunner } from "./cursor-cli-runner.js";
import { CursorAuth, CursorAuthClient } from "./auth.js";
import { CachedToolUse, mapCursorEventToAcp, RejectedToolCall } from "./cursor-event-mapper.js";
import {
	availableSlashCommands,
	CustomSlashCommand,
	handleSlashCommand,
	loadCustomSlashCommands,
	resolveCustomSlashCommandPrompt,
	resolveSkillSlashCommandPrompt,
} from "./slash-commands.js";
import { CustomSkill, loadCustomSkills } from "./skills.js";
import { parseLeadingSlashCommand, promptToCursorText } from "./prompt-conversion.js";
import {
	availableModes,
	DEFAULT_MODE_ID,
	parseDefaultMode,
	parseDefaultModel,
	SessionModeId,
	SUPPORTED_MODE_IDS,
} from "./settings.js";
import {
	findSessionFile,
	listSessions,
	readSessionMeta,
	recordAssistantMessage,
	recordSessionMeta,
	recordUserMessage,
	replaySessionHistory,
} from "./session-storage.js";
import { Logger, unreachable } from "./utils.js";

interface SessionState {
	sessionId: string;
	cwd: string;
	backendSessionId?: string;
	modeId: SessionModeId;
	modelId?: string;
	customCommands: CustomSlashCommand[];
	skills: CustomSkill[];
	cancelled: boolean;
	activeRun?: {
		cancel: () => void;
	};
}

interface PromptAttemptResult {
	stopReason: PromptResponse["stopReason"];
	rejectedToolCalls: RejectedToolCall[];
}

export interface CursorAcpAgentOptions {
	runner?: CursorCliRunner;
	auth?: CursorAuthClient;
	logger?: Logger;
}

export class CursorAcpAgent implements Agent {
	private readonly sessions: Record<string, SessionState> = {};
	private clientCapabilities?: ClientCapabilities;

	private readonly runner: CursorCliRunner;
	private readonly auth: CursorAuthClient;
	private readonly logger: Logger;

	constructor(
		private readonly client: AgentSideConnection,
		options: CursorAcpAgentOptions = {},
	) {
		this.runner = options.runner ?? new CursorCliRunner();
		this.auth = options.auth ?? new CursorAuth();
		this.logger = options.logger ?? console;
	}

	async initialize(request: InitializeRequest): Promise<InitializeResponse> {
		this.clientCapabilities = request.clientCapabilities;

		const authMethod: {
			id: string;
			name: string;
			description: string;
			_meta?: {
				"terminal-auth": {
					command: string;
					args: string[];
					label: string;
				};
			};
		} = {
			id: "cursor-login",
			name: "Log in with Cursor CLI",
			description: "Run `agent login`",
		};

		if (request.clientCapabilities?._meta?.["terminal-auth"] === true) {
			authMethod._meta = {
				"terminal-auth": {
					command: "agent",
					args: ["login"],
					label: "Cursor CLI Login",
				},
			};
		}

		return {
			protocolVersion: 1,
			agentCapabilities: {
				promptCapabilities: {
					image: true,
					embeddedContext: true,
				},
				sessionCapabilities: {
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
		return await this.createSession({ sessionId, cwd: params.cwd });
	}

	async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
		const sessionId = randomUUID();
		return await this.createSession({
			sessionId,
			cwd: params.cwd,
			backendSessionId: params.sessionId,
		});
	}

	async unstable_resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		const filePath = await findSessionFile(params.sessionId, params.cwd);
		const { backendSessionId } = filePath
			? await readSessionMeta(filePath)
			: { backendSessionId: undefined };

		const response = await this.createSession({
			sessionId: params.sessionId,
			cwd: params.cwd,
			backendSessionId: backendSessionId ?? params.sessionId,
		});

		// Replay session history so the client sees previous messages
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
		mcpServers?: unknown[];
	}): Promise<{ modes: NewSessionResponse["modes"]; models: NewSessionResponse["models"] }> {
		const filePath = await findSessionFile(params.sessionId, params.cwd);
		if (!filePath) {
			throw new Error("Session not found");
		}

		const { backendSessionId } = await readSessionMeta(filePath);

		const response = await this.createSession({
			sessionId: params.sessionId,
			cwd: params.cwd,
			backendSessionId: backendSessionId ?? params.sessionId,
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

	async authenticate(_params: AuthenticateRequest): Promise<void> {
		const status = await this.auth.ensureLoggedIn();
		if (!status.loggedIn) {
			throw RequestError.authRequired();
		}
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const session = this.sessions[params.sessionId];
		if (!session) {
			throw RequestError.invalidParams("Session not found");
		}

		const status = await this.auth.status();
		if (!status.loggedIn) {
			throw RequestError.authRequired();
		}

		session.cancelled = false;
		let promptText = promptToCursorText(params);

		// Record user message to session history
		await recordUserMessage(session.cwd, session.sessionId, promptText);

		const slash = parseLeadingSlashCommand(promptText);
		if (slash.hasSlash) {
			const handled = await handleSlashCommand(slash.command, slash.args, {
				session,
				auth: this.auth,
				listModels: async () => await this.runner.listModels(),
				customCommands: session.customCommands,
				skills: session.skills,
				onModeChanged: async (modeId) => {
					await this.client.sessionUpdate({
						sessionId: session.sessionId,
						update: {
							sessionUpdate: "current_mode_update",
							currentModeId: modeId,
						},
					});
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
				}

				if (session.cancelled) {
					return { stopReason: "cancelled" };
				}

				return { stopReason: "end_turn" };
			}

			const skillPrompt = resolveSkillSlashCommandPrompt(slash.command, session.skills);
			if (skillPrompt) {
				const extra = slash.args.trim();
				promptText = extra ? `${skillPrompt}\n\n${extra}` : skillPrompt;
			} else {
				const customPrompt = resolveCustomSlashCommandPrompt(
					slash.command,
					slash.args,
					session.customCommands,
				);
				if (customPrompt) {
					promptText = customPrompt;
				}
			}
		}

		const firstAttempt = await this.runPromptAttempt(session, promptText, false);

		if (firstAttempt.stopReason === "cancelled" || session.cancelled) {
			return { stopReason: "cancelled" };
		}

		if (
			firstAttempt.stopReason === "end_turn" &&
			(session.modeId === "default" || session.modeId === "acceptEdits") &&
			firstAttempt.rejectedToolCalls.length > 0
		) {
			const approved = await this.requestPermissionToRetry(
				session.sessionId,
				firstAttempt.rejectedToolCalls[0],
			);

			if (session.cancelled) {
				return { stopReason: "cancelled" };
			}

			if (approved === "allow_always") {
				session.modeId = "bypassPermissions";
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
		const session = this.sessions[params.sessionId];
		if (!session) {
			throw RequestError.invalidParams("Session not found");
		}

		session.cancelled = true;
		session.activeRun?.cancel();
	}

	async unstable_setSessionModel(
		params: SetSessionModelRequest,
	): Promise<SetSessionModelResponse | void> {
		const session = this.sessions[params.sessionId];
		if (!session) {
			throw RequestError.invalidParams("Session not found");
		}

		session.modelId = params.modelId;
		return {};
	}

	async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
		const session = this.sessions[params.sessionId];
		if (!session) {
			throw RequestError.invalidParams("Session not found");
		}

		if (!SUPPORTED_MODE_IDS.includes(params.modeId as SessionModeId)) {
			throw RequestError.invalidParams(`Invalid mode: ${params.modeId}`);
		}

		session.modeId = params.modeId as SessionModeId;
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
		backendSessionId?: string;
	}): Promise<NewSessionResponse> {
		const modeId = parseDefaultMode() ?? DEFAULT_MODE_ID;
		const modelId = parseDefaultModel();

		const session: SessionState = {
			sessionId: params.sessionId,
			cwd: params.cwd,
			backendSessionId: params.backendSessionId,
			modeId,
			modelId,
			customCommands: [],
			skills: [],
			cancelled: false,
		};

		if (!session.backendSessionId) {
			try {
				session.backendSessionId = await this.runner.createChat();
			} catch (error) {
				this.logger.error(
					"[cursor-acp] create-chat failed, using lazy backend session binding",
					error,
				);
			}
		}

		// Persist session metadata so loadSession can recover the backendSessionId
		try {
			await recordSessionMeta(params.cwd, params.sessionId, session.backendSessionId);
		} catch (error) {
			this.logger.error("[cursor-acp] Failed to record session meta", error);
		}

		const models = await this.getAvailableModels(session);
		session.customCommands = await this.getAvailableSlashCommands(session.cwd);
		session.skills = await this.getAvailableSkills(session.cwd);
		this.sessions[session.sessionId] = session;

		setTimeout(() => {
			void this.emitAvailableCommands(session);
		}, 0);

		return {
			sessionId: session.sessionId,
			models,
			modes: availableModes(session.modeId),
		};
	}

	private async getAvailableModels(session: SessionState): Promise<SessionModelState> {
		let listed = [] as Awaited<ReturnType<CursorCliRunner["listModels"]>>;
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

	private async getAvailableSlashCommands(workspace: string): Promise<CustomSlashCommand[]> {
		try {
			return await loadCustomSlashCommands(workspace);
		} catch (error) {
			this.logger.error("[cursor-acp] Unable to load custom slash commands", error);
			return [];
		}
	}

	private async getAvailableSkills(workspace: string): Promise<CustomSkill[]> {
		try {
			const skills = await loadCustomSkills(workspace);
			return skills.filter((skill) => skill.origin === "user");
		} catch (error) {
			this.logger.error("[cursor-acp] Unable to load skills", error);
			return [];
		}
	}

	private async emitAvailableCommands(session: SessionState): Promise<void> {
		await this.client.sessionUpdate({
			sessionId: session.sessionId,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands: availableSlashCommands(session.customCommands, session.skills),
			},
		});
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
			case "bypassPermissions":
				return { force: true };
			case "acceptEdits":
			case "default":
				return { force: false };
			default:
				unreachable(session.modeId, this.logger);
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
				}

				if (
					mapped.currentModeId &&
					SUPPORTED_MODE_IDS.includes(mapped.currentModeId as SessionModeId)
				) {
					session.modeId = mapped.currentModeId as SessionModeId;
				}

				if (mapped.rejectedToolCall) {
					rejectedToolCalls.push(mapped.rejectedToolCall);
				}

				for (const notification of mapped.notifications) {
					// Collect assistant text for history recording
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
				throw RequestError.internalError(undefined, "Cursor CLI did not emit a result event");
			}

			const subtype = typeof resultEvent.subtype === "string" ? resultEvent.subtype : "";
			const isError = resultEvent.is_error === true;

			if (subtype === "success" && !isError) {
				// Record assistant response to session history
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

			const resultText = typeof resultEvent.result === "string" ? resultEvent.result : subtype;
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
}

export function maybeEmitSessionUpdate(
	client: AgentSideConnection,
	notification: SessionNotification,
): Promise<void> {
	return client.sessionUpdate(notification);
}
