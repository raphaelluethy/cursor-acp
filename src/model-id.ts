import type { CursorModelDescriptor, ModelParameterDescriptor } from "./slash-commands.js";

export const THINKING_PARAM_ID = "thinking";
export const FAST_PARAM_ID = "fast";

const AUTO_MODEL: CursorModelDescriptor = {
	modelId: "auto",
	name: "Auto",
};

const THINKING_LEVELS = ["none", "low", "medium", "high", "xhigh", "extra-high", "max"];

const THINKING_LEVEL_LABELS: Record<string, string> = {
	none: "None",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra High",
	"extra-high": "Extra High",
	max: "Max",
	true: "On",
	false: "Off",
};

interface ParsedLegacyModelId {
	baseModelId: string;
	fast?: boolean;
	thinking?: string;
}

interface CliVariantInfo {
	modelId: string;
	groupId: string;
	fast: boolean;
	level?: string;
	thinking?: boolean;
}

function parseLegacyModelId(modelId: string): ParsedLegacyModelId | null {
	const trimmed = modelId.trim();
	if (trimmed.length === 0) {
		return null;
	}

	const match = trimmed.match(/^([^[\]]+)\[([^[\]]*)\]$/);
	if (!match) {
		return null;
	}

	const [, baseModelId, rawOptions] = match;
	if (!baseModelId) {
		return null;
	}

	const parsed: ParsedLegacyModelId = { baseModelId: baseModelId.trim() };
	if (!rawOptions?.trim()) {
		return parsed;
	}

	for (const rawEntry of rawOptions.split(",")) {
		const [rawKey, rawValue] = rawEntry.split("=", 2);
		if (!rawKey || !rawValue) {
			return null;
		}

		const key = rawKey.trim().toLowerCase();
		const value = rawValue.trim().toLowerCase();
		if (key === FAST_PARAM_ID) {
			if (value !== "true" && value !== "false") {
				return null;
			}
			parsed.fast = value === "true";
			continue;
		}

		if (key === THINKING_PARAM_ID || key === "reasoning" || key === "effort") {
			parsed.thinking = value;
			continue;
		}

		return null;
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

	if (parsed.thinking) {
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

export function normalizeModelCatalog(models: CursorModelDescriptor[]): CursorModelDescriptor[] {
	const normalized = models.map((model) => {
		const modelId = normalizeModelId(model.modelId);
		if (modelId === "auto") {
			return { ...model, modelId: "auto", name: "Auto" };
		}
		return model.modelId === modelId ? model : { ...model, modelId };
	});

	const seen = new Set<string>();
	return normalized.filter((model) => {
		if (seen.has(model.modelId)) {
			return false;
		}
		seen.add(model.modelId);
		return true;
	});
}

export function ensureAutoModel(models: CursorModelDescriptor[]): CursorModelDescriptor[] {
	const normalized = normalizeModelCatalog(models);
	if (normalized.some((model) => model.modelId === AUTO_MODEL.modelId)) {
		return normalized;
	}

	return [AUTO_MODEL, ...normalized];
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

	const parsed = parseLegacyModelId(modelId);
	if (parsed?.thinking || parsed?.fast !== undefined) {
		const catalog = withCliModelParameters(models);
		const base = resolveModelId(parsed.baseModelId, catalog) ?? parsed.baseModelId;
		let resolved = base;
		if (parsed.thinking) {
			resolved = applyThinkingValue(catalog, resolved, parsed.thinking) ?? resolved;
		}
		if (parsed.fast !== undefined) {
			resolved = applyFastValue(catalog, resolved, String(parsed.fast)) ?? resolved;
		}
		return catalog.find((model) => model.modelId === resolved)?.modelId ?? resolved;
	}

	return models.find((model) => model.modelId === normalized)?.modelId ?? normalized;
}

function stripFast(modelId: string): { modelId: string; fast: boolean } {
	if (modelId.endsWith("-fast")) {
		return { modelId: modelId.slice(0, -"-fast".length), fast: true };
	}
	return { modelId, fast: false };
}

function stripLevel(modelId: string): { modelId: string; level?: string } {
	const match = modelId.match(/-(extra-high|xhigh|none|low|medium|high|max)$/);
	if (!match?.[1]) {
		return { modelId };
	}
	return { modelId: modelId.slice(0, -match[0].length), level: match[1] };
}

function parseCliVariant(modelId: string): CliVariantInfo {
	const fastStripped = stripFast(modelId);
	let id = fastStripped.modelId;
	let thinking: boolean | undefined;
	let level: string | undefined;

	const thinkingWithLevel = id.match(/-thinking-(extra-high|xhigh|none|low|medium|high|max)$/);
	if (thinkingWithLevel?.[1]) {
		thinking = true;
		level = thinkingWithLevel[1];
		id = id.slice(0, -thinkingWithLevel[0].length);
	} else if (id.endsWith("-thinking")) {
		thinking = true;
		id = id.slice(0, -"-thinking".length);
	}

	const levelStripped = stripLevel(id);
	id = levelStripped.modelId;
	level ??= levelStripped.level;

	return {
		modelId,
		groupId: id,
		fast: fastStripped.fast,
		level,
		thinking,
	};
}

function allVariantInfo(models: CursorModelDescriptor[]): CliVariantInfo[] {
	const parsed = models.map((model) => parseCliVariant(model.modelId));
	const byGroup = new Map<string, CliVariantInfo[]>();
	for (const info of parsed) {
		const entries = byGroup.get(info.groupId) ?? [];
		entries.push(info);
		byGroup.set(info.groupId, entries);
	}

	return parsed.map((info) => {
		const siblings = byGroup.get(info.groupId) ?? [];
		const hasLevelSiblings = siblings.some((sibling) => sibling.level);
		const hasThinkingSiblings = siblings.some((sibling) => sibling.thinking === true);
		return {
			...info,
			level: info.level ?? (hasLevelSiblings ? "medium" : undefined),
			thinking: info.thinking ?? (hasThinkingSiblings ? false : undefined),
		};
	});
}

function paramsForVariant(info: CliVariantInfo): Array<{ id: string; value: string }> {
	const params = [{ id: FAST_PARAM_ID, value: String(info.fast) }];
	if (info.thinking !== undefined) {
		params.push({ id: THINKING_PARAM_ID, value: String(info.thinking) });
	} else if (info.level) {
		params.push({ id: THINKING_PARAM_ID, value: info.level });
	}
	return params;
}

export function withCliModelParameters(models: CursorModelDescriptor[]): CursorModelDescriptor[] {
	const normalized = ensureAutoModel(models);
	const infoById = new Map(allVariantInfo(normalized).map((info) => [info.modelId, info]));

	return normalized.map((model) => {
		if (model.modelId === "auto" || model.parameters?.length || model.variants?.length) {
			return model;
		}

		const info = infoById.get(model.modelId);
		if (!info) {
			return model;
		}

		const siblings = [...infoById.values()].filter(
			(candidate) =>
				candidate.groupId === info.groupId &&
				candidate.level === info.level &&
				candidate.thinking === info.thinking,
		);

		const parameters: ModelParameterDescriptor[] = [];
		const hasFast = siblings.some((candidate) => candidate.fast);
		const hasDefaultSpeed = siblings.some((candidate) => !candidate.fast);
		if (hasFast && hasDefaultSpeed) {
			parameters.push({
				id: FAST_PARAM_ID,
				displayName: "Fast",
				values: [
					{ value: "false", displayName: "Default" },
					{ value: "true", displayName: "Fast" },
				],
			});
		}

		const thinkingValues = resolveThinkingValues(info, [...infoById.values()]);
		if (thinkingValues.length > 1) {
			parameters.push({
				id: THINKING_PARAM_ID,
				displayName: "Thinking",
				values: thinkingValues.map((value) => ({
					value,
					displayName: THINKING_LEVEL_LABELS[value] ?? value,
				})),
			});
		}

		const variants = [...infoById.values()]
			.filter((candidate) => candidate.groupId === info.groupId)
			.map((candidate) => ({
				modelId: candidate.modelId,
				params: paramsForVariant(candidate),
				isDefault: candidate.modelId === model.modelId,
			}));

		return {
			...model,
			...(parameters.length > 0 ? { parameters } : {}),
			...(variants.length > 1 ? { variants } : {}),
		};
	});
}

function resolveThinkingValues(info: CliVariantInfo, catalog: CliVariantInfo[]): string[] {
	const siblings = catalog.filter((candidate) => candidate.groupId === info.groupId);
	const booleanSiblings = siblings.filter(
		(candidate) => candidate.level === info.level && candidate.thinking !== undefined,
	);
	if (new Set(booleanSiblings.map((candidate) => candidate.thinking)).size > 1) {
		return ["false", "true"];
	}

	const levelSiblings = siblings.filter((candidate) => candidate.thinking === info.thinking);
	const values = [
		...new Set(
			levelSiblings
				.map((candidate) => candidate.level)
				.filter((value): value is string => Boolean(value)),
		),
	];
	return values.sort((a, b) => THINKING_LEVELS.indexOf(a) - THINKING_LEVELS.indexOf(b));
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

export function getThinkingParameter(
	model: CursorModelDescriptor | undefined,
): ModelParameterDescriptor | undefined {
	const parameter = model?.parameters?.find((entry) => entry.id === THINKING_PARAM_ID);
	return parameter && parameter.values.length > 0 ? parameter : undefined;
}

export function getFastParameter(
	model: CursorModelDescriptor | undefined,
): ModelParameterDescriptor | undefined {
	const parameter = model?.parameters?.find((entry) => entry.id === FAST_PARAM_ID);
	return parameter && parameter.values.length > 0 ? parameter : undefined;
}

export function formatFastParameterOptionName(value: string, displayName?: string): string {
	const trimmedDisplayName = displayName?.trim();
	if (trimmedDisplayName) {
		return trimmedDisplayName;
	}

	if (value === "false") {
		return "Default";
	}

	if (value === "true") {
		return "Fast";
	}

	return value;
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

export function resolveDefaultFastValue(
	model: CursorModelDescriptor | undefined,
): string | undefined {
	const fastParameter = getFastParameter(model);
	if (!fastParameter || fastParameter.values.length === 0) {
		return undefined;
	}

	const defaultVariant = model?.variants?.find((variant) => variant.isDefault);
	const variantFast = defaultVariant?.params.find((param) => param.id === FAST_PARAM_ID)?.value;
	if (variantFast && fastParameter.values.some((value) => value.value === variantFast)) {
		return variantFast;
	}

	return fastParameter.values[0]?.value;
}

export function isValidThinkingLevel(
	model: CursorModelDescriptor | undefined,
	thinkingLevel: string | undefined,
): boolean {
	if (!thinkingLevel) {
		return false;
	}

	return (
		getThinkingParameter(model)?.values.some((value) => value.value === thinkingLevel) ?? false
	);
}

export function isValidFastValue(
	model: CursorModelDescriptor | undefined,
	fastValue: string | undefined,
): boolean {
	if (!fastValue) {
		return false;
	}

	return getFastParameter(model)?.values.some((value) => value.value === fastValue) ?? false;
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

export function resolveFastValue(
	model: CursorModelDescriptor | undefined,
	configuredFastValue: string | undefined,
): string | undefined {
	if (isValidFastValue(model, configuredFastValue)) {
		return configuredFastValue;
	}

	return resolveDefaultFastValue(model);
}

function findVariantByParams(
	modelCatalog: CursorModelDescriptor[],
	modelId: string,
	params: Record<string, string>,
): string | undefined {
	const info = parseCliVariant(modelId);
	const catalog = allVariantInfo(modelCatalog);
	const current = catalog.find((candidate) => candidate.modelId === modelId) ?? info;

	const targetFast =
		params[FAST_PARAM_ID] !== undefined ? params[FAST_PARAM_ID] === "true" : current.fast;
	const targetThinking =
		params[THINKING_PARAM_ID] !== undefined &&
		(current.thinking !== undefined ||
			params[THINKING_PARAM_ID] === "true" ||
			params[THINKING_PARAM_ID] === "false")
			? params[THINKING_PARAM_ID] === "true"
			: current.thinking;
	const targetLevel =
		params[THINKING_PARAM_ID] !== undefined &&
		params[THINKING_PARAM_ID] !== "true" &&
		params[THINKING_PARAM_ID] !== "false"
			? params[THINKING_PARAM_ID]
			: current.level;

	const exact = catalog.find(
		(candidate) =>
			candidate.groupId === current.groupId &&
			candidate.fast === targetFast &&
			candidate.thinking === targetThinking &&
			candidate.level === targetLevel,
	);
	if (exact) {
		return exact.modelId;
	}

	const withoutFast = catalog.find(
		(candidate) =>
			candidate.groupId === current.groupId &&
			candidate.thinking === targetThinking &&
			candidate.level === targetLevel,
	);
	return withoutFast?.modelId;
}

export function applyFastValue(
	modelCatalog: CursorModelDescriptor[] | undefined,
	modelId: string | undefined,
	fastValue: string,
): string | undefined {
	if (!modelCatalog || !modelId) {
		return undefined;
	}
	if (fastValue !== "true" && fastValue !== "false") {
		return undefined;
	}
	return findVariantByParams(withCliModelParameters(modelCatalog), modelId, {
		[FAST_PARAM_ID]: fastValue,
	});
}

export function applyThinkingValue(
	modelCatalog: CursorModelDescriptor[] | undefined,
	modelId: string | undefined,
	thinkingValue: string,
): string | undefined {
	if (!modelCatalog || !modelId) {
		return undefined;
	}
	return findVariantByParams(withCliModelParameters(modelCatalog), modelId, {
		[THINKING_PARAM_ID]: thinkingValue,
	});
}
