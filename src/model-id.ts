import type {
	CursorModelDescriptor,
	ModelParameterDescriptor,
	ModelVariantDescriptor,
} from "./slash-commands.js";

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

/** Keep sibling variants when a later model listing is temporarily incomplete. */
export function mergeModelCatalogs(
	primary: CursorModelDescriptor[],
	fallback: CursorModelDescriptor[] | undefined,
): CursorModelDescriptor[] {
	if (!fallback || fallback.length === 0) {
		return primary;
	}

	const byId = new Map<string, CursorModelDescriptor>();
	for (const model of fallback) {
		byId.set(normalizeModelId(model.modelId), model);
	}
	for (const model of primary) {
		const modelId = normalizeModelId(model.modelId);
		const previous = byId.get(modelId);
		if (!previous) {
			byId.set(modelId, model);
			continue;
		}

		byId.set(modelId, {
			...previous,
			...model,
			parameters: model.parameters?.length ? model.parameters : previous.parameters,
			variants: model.variants?.length ? model.variants : previous.variants,
		});
	}

	return [...byId.values()];
}

function modelGroupId(modelId: string): string {
	return parseCliVariant(normalizeModelId(modelId)).groupId;
}

function parameterMetadataScore(model: CursorModelDescriptor | undefined): number {
	return Number(Boolean(getFastParameter(model))) + Number(Boolean(getThinkingParameter(model)));
}

/** Resolve parameter metadata from a model group, not only the exact selected variant. */
export function findParameterModelInCatalog(
	modelCatalog: CursorModelDescriptor[] | undefined,
	modelId: string | undefined,
): CursorModelDescriptor | undefined {
	if (!modelCatalog || typeof modelId !== "string") {
		return undefined;
	}

	const normalized = normalizeModelId(modelId);
	const candidates: CursorModelDescriptor[] = [];
	const direct = findModelInCatalog(modelCatalog, normalized);

	if (normalized.endsWith("-fast")) {
		const baseModel = findModelInCatalog(modelCatalog, normalized.slice(0, -"-fast".length));
		if (baseModel) {
			candidates.push(baseModel);
		}
	}

	if (direct) {
		candidates.push(direct);
	}

	const groupId = modelGroupId(normalized);
	for (const candidate of modelCatalog) {
		if (modelGroupId(candidate.modelId) !== groupId) {
			continue;
		}
		if (!candidates.includes(candidate)) {
			candidates.push(candidate);
		}
	}

	let best = direct;
	let bestScore = parameterMetadataScore(direct);
	for (const candidate of candidates) {
		const score = parameterMetadataScore(candidate);
		if (score > bestScore) {
			best = candidate;
			bestScore = score;
		}
	}

	return best;
}

function variantParamValue(
	variant: ModelVariantDescriptor | undefined,
	parameterId: string,
): string | undefined {
	return variant?.params.find((param) => param.id === parameterId)?.value;
}

function findVariantInModel(
	model: CursorModelDescriptor | undefined,
	modelId: string | undefined,
): ModelVariantDescriptor | undefined {
	if (!model?.variants?.length || typeof modelId !== "string") {
		return undefined;
	}

	const normalized = normalizeModelId(modelId);
	return model.variants.find(
		(variant) =>
			typeof variant.modelId === "string" && normalizeModelId(variant.modelId) === normalized,
	);
}

function findVariantByDescriptorParams(
	modelCatalog: CursorModelDescriptor[] | undefined,
	modelId: string | undefined,
	params: Record<string, string>,
): string | undefined {
	const parameterModel = findParameterModelInCatalog(modelCatalog, modelId);
	if (!parameterModel?.variants?.length) {
		return undefined;
	}

	const currentVariant =
		findVariantInModel(parameterModel, modelId) ??
		parameterModel.variants.find((variant) => variant.isDefault);
	const targetParams = new Map<string, string>();
	for (const param of currentVariant?.params ?? []) {
		targetParams.set(param.id, param.value);
	}
	for (const [id, value] of Object.entries(params)) {
		targetParams.set(id, value);
	}

	for (const variant of parameterModel.variants) {
		if (typeof variant.modelId !== "string") {
			continue;
		}
		let matches = true;
		for (const [id, value] of targetParams) {
			if (variantParamValue(variant, id) !== value) {
				matches = false;
				break;
			}
		}
		if (matches) {
			return normalizeModelId(variant.modelId);
		}
	}

	return undefined;
}

export function inferParameterValueFromModelId(
	modelCatalog: CursorModelDescriptor[] | undefined,
	modelId: string | undefined,
	parameterId: string,
): string | undefined {
	const parameterModel = findParameterModelInCatalog(modelCatalog, modelId);
	const variant = findVariantInModel(parameterModel, modelId);
	const variantValue = variantParamValue(variant, parameterId);
	if (
		variantValue &&
		parameterModel?.parameters?.some(
			(parameter) =>
				parameter.id === parameterId &&
				parameter.values.some((value) => value.value === variantValue),
		)
	) {
		return variantValue;
	}

	return undefined;
}

export function getThinkingParameterForModel(
	modelCatalog: CursorModelDescriptor[] | undefined,
	modelId: string | undefined,
): ModelParameterDescriptor | undefined {
	const parameterModel = findParameterModelInCatalog(modelCatalog, modelId);
	const thinkingParameter = getThinkingParameter(parameterModel);
	if (!thinkingParameter) {
		return undefined;
	}

	if (inferParameterValueFromModelId(modelCatalog, modelId, THINKING_PARAM_ID)) {
		return thinkingParameter;
	}

	const direct = findModelInCatalog(modelCatalog, modelId);
	return direct === parameterModel && getThinkingParameter(direct)
		? thinkingParameter
		: undefined;
}

const SYNTHETIC_FAST_PARAMETER: ModelParameterDescriptor = {
	id: FAST_PARAM_ID,
	displayName: "Fast",
	values: [
		{ value: "false", displayName: "Default" },
		{ value: "true", displayName: "Fast" },
	],
};

/** Fast toggle metadata for a selected model, including inferred `-fast` variants. */
export function getFastParameterForModel(
	modelCatalog: CursorModelDescriptor[] | undefined,
	modelId: string | undefined,
): ModelParameterDescriptor | undefined {
	const parameterModel = findParameterModelInCatalog(modelCatalog, modelId);
	const existing = getFastParameter(parameterModel);
	if (existing) {
		return existing;
	}

	if (!modelCatalog || typeof modelId !== "string") {
		return undefined;
	}

	const normalized = normalizeModelId(modelId);
	if (normalized.endsWith("-fast")) {
		const baseId = normalized.slice(0, -"-fast".length);
		if (findModelInCatalog(modelCatalog, baseId)) {
			return SYNTHETIC_FAST_PARAMETER;
		}
	}

	const fastVariantId = `${normalized}-fast`;
	if (findModelInCatalog(modelCatalog, fastVariantId)) {
		return SYNTHETIC_FAST_PARAMETER;
	}

	return undefined;
}

export function inferFastValueFromModelId(
	modelCatalog: CursorModelDescriptor[] | undefined,
	modelId: string | undefined,
): string | undefined {
	const variantValue = inferParameterValueFromModelId(modelCatalog, modelId, FAST_PARAM_ID);
	if (variantValue) {
		return variantValue;
	}

	if (!modelCatalog || typeof modelId !== "string") {
		return undefined;
	}

	const normalized = normalizeModelId(modelId);
	if (normalized.endsWith("-fast")) {
		const baseId = normalized.slice(0, -"-fast".length);
		if (findModelInCatalog(modelCatalog, baseId)) {
			return "true";
		}
	}

	if (findModelInCatalog(modelCatalog, `${normalized}-fast`)) {
		return "false";
	}

	return undefined;
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
	const descriptorVariant = findVariantByDescriptorParams(modelCatalog, modelId, {
		[FAST_PARAM_ID]: fastValue,
	});
	if (descriptorVariant) {
		return descriptorVariant;
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
	const descriptorVariant = findVariantByDescriptorParams(modelCatalog, modelId, {
		[THINKING_PARAM_ID]: thinkingValue,
	});
	if (descriptorVariant) {
		return descriptorVariant;
	}

	return findVariantByParams(withCliModelParameters(modelCatalog), modelId, {
		[THINKING_PARAM_ID]: thinkingValue,
	});
}
