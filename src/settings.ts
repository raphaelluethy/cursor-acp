export const ADAPTER_NAME = "cursor-acp";

export const ADVERTISED_MODE_IDS = ["default", "autoRunAllCommands", "ask", "plan"] as const;

export const LEGACY_MODE_ALIASES = {
	acceptEdits: "default",
	bypassPermissions: "autoRunAllCommands",
	agent: "default",
} as const;

export type SessionModeId = (typeof ADVERTISED_MODE_IDS)[number];

export const DEFAULT_MODE_ID: SessionModeId = "default";

export function normalizeModeId(value: string): SessionModeId | null {
	if (ADVERTISED_MODE_IDS.includes(value as SessionModeId)) {
		return value as SessionModeId;
	}

	if (value in LEGACY_MODE_ALIASES) {
		return LEGACY_MODE_ALIASES[value as keyof typeof LEGACY_MODE_ALIASES];
	}

	return null;
}

export function parseDefaultMode(): SessionModeId {
	const value = process.env.CURSOR_ACP_DEFAULT_MODE;
	if (!value) {
		return DEFAULT_MODE_ID;
	}

	return normalizeModeId(value) ?? DEFAULT_MODE_ID;
}

export function parseDefaultModel(): string | undefined {
	const value = process.env.CURSOR_ACP_DEFAULT_MODEL;
	if (!value) {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function availableModes(currentModeId: SessionModeId) {
	return {
		currentModeId,
		availableModes: [
			{
				id: "default",
				name: "Default",
				description: "Standard agent mode with client-mediated permission prompts",
			},
			{
				id: "autoRunAllCommands",
				name: "Auto Run All Commands",
				description: "Agent mode with automatic approval for native permission requests",
			},
			{
				id: "ask",
				name: "Ask",
				description: "Q&A mode with no edits or command execution",
			},
			{
				id: "plan",
				name: "Plan",
				description: "Read-only planning mode",
			},
		],
	};
}
