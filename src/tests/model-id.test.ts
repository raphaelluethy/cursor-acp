import { describe, expect, it } from "vitest";
import { normalizeModelId, resolveModelId } from "../model-id.js";

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
});
