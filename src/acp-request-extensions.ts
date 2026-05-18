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
	defaultConfigOptions?: { mode?: unknown; model?: unknown };
	default_config_options?: { mode?: unknown; model?: unknown };
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
