import type {
	InitializeRequest,
	LoadSessionResponse,
	NewSessionRequest,
	NewSessionResponse,
	PromptResponse,
	RequestPermissionRequest,
	SessionNotification,
	SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import type {
	ExtendedInitializeRequest,
	ExtendedNewSessionRequest,
} from "../acp-request-extensions.js";
import type { CursorAcpClient } from "../cursor-acp-client.js";
import type { CursorAcpAgent, SessionState } from "../cursor-acp-agent.js";
import type {
	CursorCliRunnerLike,
	CursorStreamEvent,
	RunPromptOptions,
} from "../cursor-cli-runner.js";
import type { CursorAuthClient } from "../auth.js";
import type { Logger } from "../utils.js";

export const noopLogger: Logger = {
	log() {},
	error() {},
};

/** Build an initialize request that may include client extension fields. */
export function initRequest(
	overrides: Partial<InitializeRequest> &
		Omit<ExtendedInitializeRequest, keyof InitializeRequest> = {},
): InitializeRequest {
	return {
		protocolVersion: 1,
		clientCapabilities: {},
		...overrides,
	} as InitializeRequest;
}

/** Build a newSession request that may include client extension fields. */
export function newSessionRequest(
	overrides: Partial<NewSessionRequest> &
		Omit<ExtendedNewSessionRequest, keyof NewSessionRequest> = {},
): NewSessionRequest {
	return {
		cwd: "/tmp",
		mcpServers: [],
		...overrides,
	} as NewSessionRequest;
}

export interface CursorAcpAgentTestAccess {
	sessions: Record<string, SessionState>;
	ensureBackend(session: SessionState): Promise<void>;
	applyNativeSessionModelsAndModes(
		session: SessionState,
		loaded: LoadSessionResponse,
	): Promise<void>;
	restartBackend(session: SessionState): Promise<void>;
}

export function agentTestAccess(agent: CursorAcpAgent): CursorAcpAgentTestAccess {
	return agent as unknown as CursorAcpAgentTestAccess;
}

export async function ensureNativeBackend(agent: CursorAcpAgent, sessionId: string): Promise<void> {
	const access = agentTestAccess(agent);
	const session = access.sessions[sessionId];
	if (!session) {
		throw new Error(`Unknown session: ${sessionId}`);
	}
	await access.ensureBackend(session);
}

export function getSessionState(agent: CursorAcpAgent, sessionId: string): SessionState {
	const session = agentTestAccess(agent).sessions[sessionId];
	if (!session) {
		throw new Error(`Unknown session: ${sessionId}`);
	}
	return session;
}

export async function awaitNativeWarmup(agent: CursorAcpAgent, sessionId: string): Promise<void> {
	await agentTestAccess(agent).sessions[sessionId]?.nativeStartPromise;
}

export type TestAuthClient = CursorAuthClient;

export type TestCliRunner = CursorCliRunnerLike;

export type TestCursorAcpClient = CursorAcpClient & {
	updates: SessionNotification[];
	permissionCalls: RequestPermissionRequest[];
};

export type TestNativeSessionResult = NewSessionResponse | LoadSessionResponse;

export type TestPromptResponse = PromptResponse;

export type TestSetNativeModeResponse = SetSessionModeResponse | Record<string, never>;

export type LegacyPromptHandler = (
	promptText: string,
	options: Pick<RunPromptOptions, "backendSessionId" | "force" | "onEvent">,
) => Promise<{
	events: CursorStreamEvent[];
	resultEvent?: CursorStreamEvent;
	stderr: string;
	exitCode: number;
}>;
