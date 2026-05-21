import type { ModelSelection } from "@cursor/sdk";
import type { CursorModelDescriptor, ModelParameterDescriptor } from "./slash-commands.js";

export const THINKING_PARAM_ID = "thinking";

const AUTO_MODEL: CursorModelDescriptor = {
	modelId: "auto",
	name: "Auto",
};

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

export function ensureAutoModel(models: CursorModelDescriptor[]): CursorModelDescriptor[] {
	if (models.some((model) => model.modelId === AUTO_MODEL.modelId)) {
		return models;
	}

	return [AUTO_MODEL, ...models];
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

export function getThinkingParameter(
	model: CursorModelDescriptor | undefined,
): ModelParameterDescriptor | undefined {
	return model?.parameters?.find((parameter) => parameter.id === THINKING_PARAM_ID);
}

export function resolveDefaultThinkingLevel(
	model: CursorModelDescriptor | undefined,
): string | undefined {
	const thinkingParameter = getThinkingParameter(model);
	if (!thinkingParameter || thinkingParameter.values.length === 0) {
		return undefined;
	}

	const defaultVariant = model?.variants?.find((variant) => variant.isDefault);
	const variantThinking = defaultVariant?.params.find(
		(param) => param.id === THINKING_PARAM_ID,
	)?.value;
	if (
		variantThinking &&
		thinkingParameter.values.some((value) => value.value === variantThinking)
	) {
		return variantThinking;
	}

	return thinkingParameter.values[0]?.value;
}

export function isValidThinkingLevel(
	model: CursorModelDescriptor | undefined,
	thinkingLevel: string | undefined,
): boolean {
	if (!thinkingLevel) {
		return false;
	}

	const thinkingParameter = getThinkingParameter(model);
	if (!thinkingParameter) {
		return false;
	}

	return thinkingParameter.values.some((value) => value.value === thinkingLevel);
}

export function resolveThinkingLevel(
	model: CursorModelDescriptor | undefined,
	configuredThinkingLevel: string | undefined,
): string | undefined {
	if (isValidThinkingLevel(model, configuredThinkingLevel)) {
		return configuredThinkingLevel;
	}

	return resolveDefaultThinkingLevel(model);
}

export function findModelInCatalog(
	modelCatalog: CursorModelDescriptor[] | undefined,
	modelId: string | undefined,
): CursorModelDescriptor | undefined {
	if (!modelCatalog || typeof modelId !== "string") {
		return undefined;
	}

	const normalized = normalizeModelId(modelId);
	return modelCatalog.find((model) => model.modelId === normalized);
}

export function buildSdkModelSelection(
	modelId: string,
	thinkingLevel?: string,
	modelCatalog?: CursorModelDescriptor[],
): ModelSelection {
	const normalizedModelId = normalizeModelId(modelId);
	const model = findModelInCatalog(modelCatalog, normalizedModelId);
	const effectiveThinkingLevel = resolveThinkingLevel(model, thinkingLevel);

	const selection: ModelSelection = { id: normalizedModelId };
	if (effectiveThinkingLevel && getThinkingParameter(model)) {
		selection.params = [{ id: THINKING_PARAM_ID, value: effectiveThinkingLevel }];
	}

	return selection;
}
