import { describe, expect, it } from "vitest";
import {
	ADVERTISED_MODE_IDS,
	isAgentSessionMode,
	modeDisplayName,
	normalizeModeId,
} from "../settings.js";

describe("settings modes", () => {
	it("advertises auto-review between default and yolo", () => {
		expect(ADVERTISED_MODE_IDS).toEqual(["default", "auto-review", "yolo", "ask", "plan"]);
	});

	it("normalizes auto-review ids and camelCase alias", () => {
		expect(normalizeModeId("auto-review")).toBe("auto-review");
		expect(normalizeModeId("autoReview")).toBe("auto-review");
		expect(normalizeModeId("yolo")).toBe("yolo");
		expect(normalizeModeId("bypassPermissions")).toBeNull();
	});

	it("treats auto-review as an agent session mode", () => {
		expect(isAgentSessionMode("auto-review")).toBe(true);
		expect(isAgentSessionMode("yolo")).toBe(true);
		expect(isAgentSessionMode("default")).toBe(true);
		expect(isAgentSessionMode("ask")).toBe(false);
		expect(isAgentSessionMode("plan")).toBe(false);
		expect(modeDisplayName("auto-review")).toBe("Auto-review");
	});
});
