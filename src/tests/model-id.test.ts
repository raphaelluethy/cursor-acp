import { describe, expect, it } from "vitest";
import {
	applyFastValue,
	applyThinkingValue,
	normalizeModelId,
	resolveModelId,
	withCliModelParameters,
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
});
