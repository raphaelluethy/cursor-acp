import { afterEach, describe, expect, it } from "vitest";
import { getCursorApiKey, shouldUseCursorSdk } from "../cursor-sdk-config.js";

describe("cursor sdk config", () => {
	const originalApiKey = process.env.CURSOR_API_KEY;

	afterEach(() => {
		if (originalApiKey === undefined) {
			delete process.env.CURSOR_API_KEY;
		} else {
			process.env.CURSOR_API_KEY = originalApiKey;
		}
	});

	it("prefers SDK when CURSOR_API_KEY is set", () => {
		process.env.CURSOR_API_KEY = "test-key";
		expect(shouldUseCursorSdk()).toBe(true);
		expect(getCursorApiKey()).toBe("test-key");
	});

	it("does not use SDK when CURSOR_API_KEY is missing", () => {
		delete process.env.CURSOR_API_KEY;
		expect(shouldUseCursorSdk()).toBe(false);
	});
});
