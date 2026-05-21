import type { ModelSelection } from "@cursor/sdk";
import type { CursorModelDescriptor, ModelParameterDescriptor } from "./slash-commands.js";

/** SDK parameter ids that represent reasoning / thinking effort for ACP `thought_level`. */
export const THOUGHT_LEVEL_PARAM_IDS = ["reasoning", "effort", "thinking"] as const;
export type ThoughtLevelParamId = (typeof THOUGHT_LEVEL_PARAM_IDS)[number];

export const FAST_PARAM_ID = "fast";

const AUTO_MODEL: CursorModelDescriptor = {
	modelId: "auto",
	name: "Auto",
};

export function normalizeModelId(modelId: string): string {
	const trimmed = modelId.trim();
	if (trimmed.length === 0) {
		return trimmed;
	}

	if (/^default$/i.test(trimmed)) {
		return "auto";
	}

	return trimmed;
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

	return models.find((model) => model.modelId === normalized)?.modelId ?? normalized;
}

export function isThoughtLevelParamId(value: string): value is ThoughtLevelParamId {
	return (THOUGHT_LEVEL_PARAM_IDS as readonly string[]).includes(value);
}

export function getThoughtLevelParameter(
	model: CursorModelDescriptor | undefined,
): ModelParameterDescriptor | undefined {
	if (!model?.parameters) {
		return undefined;
	}

	for (const paramId of THOUGHT_LEVEL_PARAM_IDS) {
		const parameter = model.parameters.find((entry) => entry.id === paramId);
		if (parameter && parameter.values.length > 0) {
			return parameter;
		}
	}

	return undefined;
}

export function getFastParameter(
	model: CursorModelDescriptor | undefined,
): ModelParameterDescriptor | undefined {
	const parameter = model?.parameters?.find((entry) => entry.id === FAST_PARAM_ID);
	return parameter && parameter.values.length > 0 ? parameter : undefined;
}

/** Human-readable label for a fast parameter option when the SDK omits `displayName`. */
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

function resolveDefaultParameterValue(
	model: CursorModelDescriptor | undefined,
	parameter: ModelParameterDescriptor | undefined,
): string | undefined {
	if (!parameter || parameter.values.length === 0) {
		return undefined;
	}

	const defaultVariant = model?.variants?.find((variant) => variant.isDefault);
	const variantValue = defaultVariant?.params.find((param) => param.id === parameter.id)?.value;
	if (variantValue && parameter.values.some((value) => value.value === variantValue)) {
		return variantValue;
	}

	return parameter.values[0]?.value;
}

export function resolveDefaultThoughtLevel(
	model: CursorModelDescriptor | undefined,
	paramId?: string,
): string | undefined {
	const thoughtParameter = paramId
		? model?.parameters?.find((parameter) => parameter.id === paramId)
		: getThoughtLevelParameter(model);
	return resolveDefaultParameterValue(model, thoughtParameter);
}

export function resolveDefaultFastValue(
	model: CursorModelDescriptor | undefined,
): string | undefined {
	return resolveDefaultParameterValue(model, getFastParameter(model));
}

function isValidParameterValue(
	parameter: ModelParameterDescriptor | undefined,
	value: string | undefined,
): boolean {
	if (!value || !parameter) {
		return false;
	}

	return parameter.values.some((entry) => entry.value === value);
}

export function isValidThoughtLevel(
	model: CursorModelDescriptor | undefined,
	paramId: string | undefined,
	value: string | undefined,
): boolean {
	if (!paramId) {
		return false;
	}

	return isValidParameterValue(
		model?.parameters?.find((entry) => entry.id === paramId),
		value,
	);
}

export function isValidFastValue(
	model: CursorModelDescriptor | undefined,
	value: string | undefined,
): boolean {
	return isValidParameterValue(getFastParameter(model), value);
}

export function resolveThoughtLevel(
	model: CursorModelDescriptor | undefined,
	paramId: string | undefined,
	configuredValue: string | undefined,
): string | undefined {
	if (isValidThoughtLevel(model, paramId, configuredValue)) {
		return configuredValue;
	}

	return resolveDefaultThoughtLevel(model, paramId);
}

export function resolveFastValue(
	model: CursorModelDescriptor | undefined,
	configuredValue: string | undefined,
): string | undefined {
	if (isValidFastValue(model, configuredValue)) {
		return configuredValue;
	}

	return resolveDefaultFastValue(model);
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

export function resolveParameterModel(
	modelCatalog: CursorModelDescriptor[] | undefined,
	modelId: string | undefined,
): CursorModelDescriptor | undefined {
	if (normalizeModelId(modelId ?? "") === "auto") {
		return findModelInCatalog(modelCatalog, modelId);
	}

	const direct = findModelInCatalog(modelCatalog, modelId);
	if (direct && direct.modelId !== "auto" && getThoughtLevelParameter(direct)) {
		return direct;
	}

	if (direct && direct.modelId !== "auto") {
		return direct;
	}

	const currentModel = modelCatalog?.find((model) => model.current);
	if (currentModel && getThoughtLevelParameter(currentModel)) {
		return currentModel;
	}

	return (
		modelCatalog?.find(
			(model) => model.modelId !== "auto" && getThoughtLevelParameter(model) !== undefined,
		) ?? direct
	);
}

export function resolveFastParameterModel(
	modelCatalog: CursorModelDescriptor[] | undefined,
	modelId: string | undefined,
): CursorModelDescriptor | undefined {
	if (normalizeModelId(modelId ?? "") === "auto") {
		return findModelInCatalog(modelCatalog, modelId);
	}

	const direct = findModelInCatalog(modelCatalog, modelId);
	if (direct && direct.modelId !== "auto" && getFastParameter(direct)) {
		return direct;
	}

	if (direct && direct.modelId !== "auto") {
		return direct;
	}

	const currentModel = modelCatalog?.find((model) => model.current);
	if (currentModel && getFastParameter(currentModel)) {
		return currentModel;
	}

	return (
		modelCatalog?.find(
			(model) => model.modelId !== "auto" && getFastParameter(model) !== undefined,
		) ?? direct
	);
}

export function buildSdkModelSelection(
	modelId: string,
	thoughtLevel?: string,
	modelCatalog?: CursorModelDescriptor[],
	thoughtParamId?: string,
	fastValue?: string,
): ModelSelection {
	const normalizedModelId = normalizeModelId(modelId);
	if (normalizedModelId === "auto") {
		return { id: normalizedModelId };
	}

	const parameterModel = resolveParameterModel(modelCatalog, normalizedModelId);
	const thoughtParameter =
		(thoughtParamId
			? parameterModel?.parameters?.find((parameter) => parameter.id === thoughtParamId)
			: undefined) ?? getThoughtLevelParameter(parameterModel);
	const effectiveThoughtLevel = resolveThoughtLevel(
		parameterModel,
		thoughtParameter?.id,
		thoughtLevel,
	);
	const fastParameterModel = resolveFastParameterModel(modelCatalog, normalizedModelId);
	const effectiveFastValue = resolveFastValue(fastParameterModel, fastValue);

	const params: ModelSelection["params"] = [];
	if (effectiveThoughtLevel && thoughtParameter) {
		params.push({ id: thoughtParameter.id, value: effectiveThoughtLevel });
	}
	if (effectiveFastValue && getFastParameter(fastParameterModel)) {
		params.push({ id: FAST_PARAM_ID, value: effectiveFastValue });
	}

	const selection: ModelSelection = { id: normalizedModelId };
	if (params.length > 0) {
		selection.params = params;
	}

	return selection;
}
