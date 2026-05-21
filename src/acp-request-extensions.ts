import type {
	ClientCapabilities,
	InitializeRequest,
	NewSessionRequest,
} from "@agentclientprotocol/sdk";

/** Non-standard mode/model fields some ACP clients send on initialize or session/new. */
export type LooseSessionDefaults = {
	modeId?: unknown;
	mode_id?: unknown;
	mode?: unknown;
	defaultModeId?: unknown;
	default_mode?: unknown;
	modelId?: unknown;
	model_id?: unknown;
	model?: unknown;
	defaultModelId?: unknown;
	default_model?: unknown;
	thinkingLevel?: unknown;
	thinking_level?: unknown;
	thinking?: unknown;
	defaultThinkingLevel?: unknown;
	default_thinking_level?: unknown;
	defaultThinking?: unknown;
	default_thinking?: unknown;
	defaultConfigOptions?: { mode?: unknown; model?: unknown; thinking?: unknown };
	default_config_options?: { mode?: unknown; model?: unknown; thinking?: unknown };
	_meta?: LooseSessionDefaults;
};

export type ExtendedNewSessionRequest = NewSessionRequest & LooseSessionDefaults;

export type ExtendedInitializeRequest = InitializeRequest &
	LooseSessionDefaults & {
		clientCapabilities?: ClientCapabilities & { _meta?: LooseSessionDefaults };
	};

export function looseSessionDefaults(value: object): LooseSessionDefaults {
	return value as LooseSessionDefaults;
}
