import type {
	LoadSessionResponse,
	NewSessionResponse,
	ResumeSessionResponse,
} from "@agentclientprotocol/sdk";

/** Cursor's pre-config-options model picker, retained for older ACP clients. */
export interface LegacySessionModels {
	currentModelId: string;
	availableModels: Array<{
		modelId: string;
		name: string;
		description?: string;
	}>;
}

export type ExtendedNewSessionResponse = NewSessionResponse & {
	models?: LegacySessionModels;
};

export type ExtendedLoadSessionResponse = LoadSessionResponse & {
	models?: LegacySessionModels;
};

export type ExtendedResumeSessionResponse = ResumeSessionResponse & {
	models?: LegacySessionModels;
};

export interface LegacySetSessionModelRequest {
	sessionId: string;
	modelId: string;
}

export type LegacySetSessionModelResponse = Record<string, never>;
