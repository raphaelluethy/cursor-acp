import { CursorModelDescriptor } from "./slash-commands.js";

interface ParsedLegacyModelId {
	baseModelId: string;
	fast?: boolean;
}

function parseLegacyModelId(modelId: string): ParsedLegacyModelId | null {
	const trimmed = modelId.trim();
	if (trimmed.length === 0) {
		return null;
	}

	const match = trimmed.match(/^([^[\]]+)\[([^[\]]+)\]$/);
	if (!match) {
		return null;
	}

	const [, baseModelId, rawOptions] = match;
	if (!baseModelId || !rawOptions) {
		return null;
	}

	const parsed: ParsedLegacyModelId = { baseModelId: baseModelId.trim() };
	for (const rawEntry of rawOptions.split(",")) {
		const [rawKey, rawValue] = rawEntry.split("=", 2);
		if (!rawKey || !rawValue) {
			return null;
		}

		const key = rawKey.trim().toLowerCase();
		const value = rawValue.trim().toLowerCase();
		if (key !== "fast") {
			return null;
		}
		if (value !== "true" && value !== "false") {
			return null;
		}

		parsed.fast = value === "true";
	}

	return parsed;
}

function isDefaultModelAlias(modelId: string): boolean {
	return /^default(?:\[[^[\]]*\])?$/i.test(modelId.trim());
}

export function normalizeModelId(modelId: string): string {
	const trimmed = modelId.trim();
	if (trimmed.length === 0) {
		return trimmed;
	}

	if (isDefaultModelAlias(trimmed)) {
		return "auto";
	}

	const parsed = parseLegacyModelId(trimmed);
	if (!parsed) {
		return trimmed;
	}

	if (parsed.fast === true) {
		return parsed.baseModelId.endsWith("-fast")
			? parsed.baseModelId
			: `${parsed.baseModelId}-fast`;
	}

	if (parsed.fast === false) {
		return parsed.baseModelId.replace(/-fast$/, "");
	}

	return parsed.baseModelId;
}

export function resolveModelId(
	modelId: string | undefined,
	models: CursorModelDescriptor[],
): string | undefined {
	if (typeof modelId !== "string") {
		return undefined;
	}

	const normalized = normalizeModelId(modelId);
	if (normalized.length === 0) {
		return undefined;
	}

	return models.find((model) => model.modelId === normalized)?.modelId ?? normalized;
}
