import { describe, expect, it } from "vitest";
import {
	ensureAutoModel,
	formatFastParameterOptionName,
	normalizeModelId,
	resolveModelId,
} from "../model-id.js";

describe("model catalog for ACP", () => {
	it("maps the SDK default model id to auto", () => {
		expect(normalizeModelId("default")).toBe("auto");
		expect(normalizeModelId("composer-2.5")).toBe("composer-2.5");
	});

	it("resolves the SDK default model id against listed models", () => {
		expect(
			resolveModelId("default", [
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

	it("normalizes SDK default model to auto without duplicating Auto", () => {
		expect(
			ensureAutoModel([
				{ modelId: "default", name: "Auto", current: true },
				{ modelId: "gpt-5.5", name: "GPT-5.5" },
			]),
		).toEqual([
			{ modelId: "auto", name: "Auto", current: true },
			{ modelId: "gpt-5.5", name: "GPT-5.5" },
		]);
	});

	it("formats fast parameter options for ACP config display", () => {
		expect(formatFastParameterOptionName("false")).toBe("Default");
		expect(formatFastParameterOptionName("true")).toBe("Fast");
		expect(formatFastParameterOptionName("true", "Fast")).toBe("Fast");
	});
});
