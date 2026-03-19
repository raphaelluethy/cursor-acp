import * as fs from "node:fs";
import * as path from "node:path";

import { getCursorAcpConfigDir } from "./session-storage.js";

export const ADAPTER_NAME = "cursor-acp";

export const ADVERTISED_MODE_IDS = ["default", "yolo", "ask", "plan"] as const;

export const LEGACY_MODE_ALIASES = {
	acceptEdits: "default",
	agent: "default",
} as const;

export type SessionModeId = (typeof ADVERTISED_MODE_IDS)[number];

export const DEFAULT_MODE_ID: SessionModeId = "default";

/** Optional `~/.cursor-acp/config.json` (or `$CURSOR_ACP_CONFIG_DIR/config.json`) fields. */
export interface CursorAcpUserConfigFile {
	default_mode?: string;
	default_model?: string;
}

function readUserConfigFile(): CursorAcpUserConfigFile {
	const configPath = path.join(getCursorAcpConfigDir(), "config.json");
	try {
		const raw = fs.readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as CursorAcpUserConfigFile;
		}
	} catch {
		// missing or invalid
	}
	return {};
}

export function normalizeModeId(value: string): SessionModeId | null {
	if (ADVERTISED_MODE_IDS.includes(value as SessionModeId)) {
		return value as SessionModeId;
	}

	if (value in LEGACY_MODE_ALIASES) {
		return LEGACY_MODE_ALIASES[value as keyof typeof LEGACY_MODE_ALIASES];
	}

	return null;
}

/** Human-readable label for slash commands and UI `name` fields (ids stay lowercase). */
export function modeDisplayName(modeId: SessionModeId): string {
	switch (modeId) {
		case "default":
			return "Default";
		case "yolo":
			return "Yolo";
		case "ask":
			return "Ask";
		case "plan":
			return "Plan";
	}
}

export function parseDefaultMode(): SessionModeId {
	const fromFile = readUserConfigFile().default_mode;
	if (typeof fromFile === "string") {
		const trimmed = fromFile.trim();
		if (trimmed.length > 0) {
			return normalizeModeId(trimmed) ?? DEFAULT_MODE_ID;
		}
	}

	return DEFAULT_MODE_ID;
}

export function parseDefaultModel(): string | undefined {
	const fromFile = readUserConfigFile().default_model;
	if (typeof fromFile === "string") {
		const trimmed = fromFile.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}

	return undefined;
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
				id: "yolo",
				name: "Yolo",
				description:
					"Agent mode with automatic approval for all native permission requests",
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
