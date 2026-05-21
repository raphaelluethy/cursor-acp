import { describe, expect, it } from "vitest";
import {
	buildSdkModelSelection,
	ensureAutoModel,
	normalizeModelId,
	resolveDefaultThinkingLevel,
	resolveModelId,
	resolveThinkingLevel,
} from "../model-id.js";
import type { CursorModelDescriptor } from "../slash-commands.js";

const THINKING_MODEL: CursorModelDescriptor = {
	modelId: "composer-2.5",
	name: "Composer 2.5",
	parameters: [
		{
			id: "thinking",
			displayName: "Thinking",
			values: [
				{ value: "low", displayName: "Low" },
				{ value: "high", displayName: "High" },
			],
		},
	],
	variants: [
		{
			params: [{ id: "thinking", value: "low" }],
			isDefault: true,
		},
	],
};

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

	it("converts legacy fast syntax to normalized model ids", () => {
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

	it("adds auto to model lists when missing", () => {
		expect(ensureAutoModel([{ modelId: "gpt-5.4-medium", name: "GPT-5.4" }])).toEqual([
			{ modelId: "auto", name: "Auto" },
			{ modelId: "gpt-5.4-medium", name: "GPT-5.4" },
		]);
	});
});

describe("thinking level selection", () => {
	it("derives the default thinking level from the default variant", () => {
		expect(resolveDefaultThinkingLevel(THINKING_MODEL)).toBe("low");
	});

	it("keeps configured thinking levels when valid for the model", () => {
		expect(resolveThinkingLevel(THINKING_MODEL, "high")).toBe("high");
	});

	it("falls back to the model default when configured thinking is invalid", () => {
		expect(resolveThinkingLevel(THINKING_MODEL, "medium")).toBe("low");
	});

	it("builds SDK model selections with thinking params", () => {
		expect(
			buildSdkModelSelection("composer-2.5", "high", [THINKING_MODEL]),
		).toEqual({
			id: "composer-2.5",
			params: [{ id: "thinking", value: "high" }],
		});
	});

	it("omits params when the model does not support thinking", () => {
		expect(
			buildSdkModelSelection("gpt-5.4-medium", "high", [
				{ modelId: "gpt-5.4-medium", name: "GPT-5.4" },
			]),
		).toEqual({ id: "gpt-5.4-medium" });
	});
});
