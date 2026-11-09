import { describe, expect, it } from "vitest";
import {
	applyFastValue,
	applyThinkingValue,
	buildSdkModelSelection,
	getFastParameterForModel,
	inferFastValueFromModelId,
	mergeModelCatalogs,
	normalizeModelId,
	resolveModelId,
	withCliModelParameters,
	withContextModelVariants,
} from "../model-id.js";

describe("model id normalization", () => {
	it("keeps current model ids unchanged", () => {
		expect(normalizeModelId("composer-2-fast")).toBe("composer-2-fast");
		expect(normalizeModelId("gpt-5.4-medium")).toBe("gpt-5.4-medium");
	});

	it("maps default model aliases to auto", () => {
		expect(normalizeModelId("default")).toBe("auto");
		expect(normalizeModelId("default[]")).toBe("auto");
		expect(normalizeModelId("default[fast=true]")).toBe("auto");
	});

	it("converts legacy fast syntax to Cursor CLI model ids", () => {
		expect(normalizeModelId("composer-2[fast=true]")).toBe("composer-2-fast");
		expect(normalizeModelId("composer-2-fast[fast=false]")).toBe("composer-2");
	});

	it("resolves legacy model ids against the listed models", () => {
		expect(
			resolveModelId("composer-2[fast=true]", [
				{ modelId: "composer-2", name: "Composer 2" },
				{ modelId: "composer-2-fast", name: "Composer 2 Fast" },
			]),
		).toBe("composer-2-fast");
	});

	it("resolves default aliases against listed models", () => {
		expect(
			resolveModelId("default[]", [
				{ modelId: "auto", name: "Auto" },
				{ modelId: "gpt-5.4-medium", name: "GPT-5.4" },
			]),
		).toBe("auto");
	});

	it("infers fast and thinking parameters from Cursor CLI model variants", () => {
		const models = withCliModelParameters([
			{ modelId: "gpt-5.5-none", name: "GPT-5.5 None" },
			{ modelId: "gpt-5.5-medium", name: "GPT-5.5" },
			{ modelId: "gpt-5.5-medium-fast", name: "GPT-5.5 Fast" },
			{ modelId: "gpt-5.5-high", name: "GPT-5.5 High" },
			{ modelId: "gpt-5.5-high-fast", name: "GPT-5.5 High Fast" },
		]);

		const medium = models.find((model) => model.modelId === "gpt-5.5-medium");
		expect(medium?.parameters?.map((parameter) => parameter.id)).toEqual(["fast", "thinking"]);
		expect(
			medium?.parameters?.find((parameter) => parameter.id === "thinking")?.values,
		).toEqual([
			{ value: "none", displayName: "None" },
			{ value: "medium", displayName: "Medium" },
			{ value: "high", displayName: "High" },
		]);
	});

	it("maps fast and thinking parameter values back to concrete CLI model ids", () => {
		const models = withCliModelParameters([
			{ modelId: "gpt-5.5-medium", name: "GPT-5.5" },
			{ modelId: "gpt-5.5-medium-fast", name: "GPT-5.5 Fast" },
			{ modelId: "gpt-5.5-high", name: "GPT-5.5 High" },
			{ modelId: "gpt-5.5-high-fast", name: "GPT-5.5 High Fast" },
		]);

		expect(applyFastValue(models, "gpt-5.5-medium", "true")).toBe("gpt-5.5-medium-fast");
		expect(applyThinkingValue(models, "gpt-5.5-medium-fast", "high")).toBe("gpt-5.5-high-fast");
	});

	it("supports legacy bracket syntax with thinking and fast values", () => {
		expect(
			resolveModelId("gpt-5.5[thinking=high,fast=true]", [
				{ modelId: "gpt-5.5-medium", name: "GPT-5.5" },
				{ modelId: "gpt-5.5-medium-fast", name: "GPT-5.5 Fast" },
				{ modelId: "gpt-5.5-high", name: "GPT-5.5 High" },
				{ modelId: "gpt-5.5-high-fast", name: "GPT-5.5 High Fast" },
			]),
		).toBe("gpt-5.5-high-fast");
	});

	it("infers fast config when only the base model variant is listed", () => {
		const catalog = withCliModelParameters([{ modelId: "composer-2.5", name: "Composer 2.5" }]);

		expect(getFastParameterForModel(catalog, "composer-2.5-fast")).toMatchObject({
			id: "fast",
		});
		expect(inferFastValueFromModelId(catalog, "composer-2.5-fast")).toBe("true");
	});

	it("merges sibling variants from an earlier model listing", () => {
		const merged = mergeModelCatalogs(
			[{ modelId: "composer-2.5-fast", name: "Composer 2.5 Fast", current: true }],
			withCliModelParameters([
				{ modelId: "composer-2.5", name: "Composer 2.5" },
				{ modelId: "composer-2.5-fast", name: "Composer 2.5 Fast" },
			]),
		);

		expect(
			getFastParameterForModel(withCliModelParameters(merged), "composer-2.5-fast"),
		).toMatchObject({ id: "fast" });
	});

	it("builds the SDK parameterized model selection used by Zed controls", () => {
		const catalog = [
			{
				modelId: "composer-2.5",
				name: "Composer 2.5",
				parameters: [
					{
						id: "fast",
						values: [{ value: "false" }, { value: "true" }],
					},
					{
						id: "thinking",
						values: [{ value: "medium" }, { value: "high" }],
					},
				],
			},
		];

		expect(buildSdkModelSelection("composer-2.5", catalog, "high", "true")).toEqual({
			id: "composer-2.5",
			params: [
				{ id: "thinking", value: "high" },
				{ id: "fast", value: "true" },
			],
		});
	});

	it("preserves the SDK reasoning parameter id behind the thinking selector", () => {
		const catalog = [
			{
				modelId: "gpt-5.6-sol",
				name: "GPT-5.6 Sol",
				parameters: [
					{
						id: "reasoning",
						values: [{ value: "low" }, { value: "high" }],
					},
					{
						id: "fast",
						values: [{ value: "false" }, { value: "true" }],
					},
				],
			},
		];

		expect(buildSdkModelSelection("gpt-5.6-sol", catalog, "high", "true")).toEqual({
			id: "gpt-5.6-sol",
			params: [
				{ id: "reasoning", value: "high" },
				{ id: "fast", value: "true" },
			],
		});
	});
});

describe("1M context model variants", () => {
	const catalog = withContextModelVariants([
		{
			modelId: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6",
			parameters: [
				{ id: "context", values: [{ value: "300k" }, { value: "1m" }] },
				{ id: "thinking", values: [{ value: "false" }, { value: "true" }] },
				{ id: "effort", values: [{ value: "low" }, { value: "high" }] },
				{ id: "fast", values: [{ value: "false" }, { value: "true" }] },
			],
			variants: [{ isDefault: true, params: [{ id: "effort", value: "high" }] }],
		},
		{ modelId: "composer-2.5", name: "Composer 2.5" },
		{
			modelId: "limited",
			name: "Limited",
			parameters: [{ id: "context", values: [{ value: "300k" }] }],
		},
		{ modelId: "auto", name: "Auto" },
	]);

	it("adds only catalog-supported 1M entries and keeps normal entries", () => {
		expect(catalog.map((model) => model.modelId)).toEqual([
			"claude-sonnet-4-6",
			"claude-sonnet-4-6[context=1m]",
			"composer-2.5",
			"limited",
			"auto",
		]);
		expect(catalog[1]?.name).toBe("Claude Sonnet 4.6 (1M)");
		expect(withContextModelVariants(catalog).map((model) => model.modelId)).toEqual(
			catalog.map((model) => model.modelId),
		);
	});

	it("maps the 1M entry to the base SDK id while retaining selected parameters", () => {
		expect(
			buildSdkModelSelection("claude-sonnet-4-6[context=1m]", catalog, "true", "true"),
		).toEqual({
			id: "claude-sonnet-4-6",
			params: [
				{ id: "effort", value: "high" },
				{ id: "thinking", value: "true" },
				{ id: "fast", value: "true" },
				{ id: "context", value: "1m" },
			],
		});
		expect(buildSdkModelSelection("claude-sonnet-4-6", catalog).params).toEqual([
			{ id: "effort", value: "high" },
		]);
	});

	it("forwards reasoning_effort and SDK variant-only params, rejecting invalid values", () => {
		const warnings: string[] = [];
		const models = [
			{
				modelId: "grok-4.7",
				name: "Grok 4.7",
				parameters: [
					{ id: "reasoning_effort", values: [{ value: "low" }, { value: "high" }] },
				],
				variants: [
					{
						isDefault: true,
						params: [
							{ id: "cyber", value: "false" },
							{ id: "reasoning_effort", value: "invalid" },
						],
					},
				],
			},
		];
		expect(
			buildSdkModelSelection("grok-4.7", models, undefined, undefined, (message) =>
				warnings.push(message),
			),
		).toEqual({ id: "grok-4.7", params: [{ id: "cyber", value: "false" }] });
		expect(warnings).toEqual([expect.stringContaining("reasoning_effort=invalid")]);
		expect(buildSdkModelSelection("grok-4.7", models, "high").params).toContainEqual({
			id: "reasoning_effort",
			value: "high",
		});
	});

	it("resolves /model bracket syntax and retains context across control changes", () => {
		expect(resolveModelId("claude-sonnet-4-6[context=1m]", catalog)).toBe(
			"claude-sonnet-4-6[context=1m]",
		);
		expect(resolveModelId("composer-2.5[context=1m]", catalog)).toBe(
			"composer-2.5[context=1m]",
		);
		expect(applyThinkingValue(catalog, "claude-sonnet-4-6[context=1m]", "true")).toBe(
			"claude-sonnet-4-6[context=1m]",
		);
	});
});
