import { afterEach, describe, expect, it } from "vitest";
import { getCursorApiKey, shouldUseCursorSdk } from "../cursor-sdk-config.js";

describe("cursor sdk config", () => {
	const originalApiKey = process.env.CURSOR_API_KEY;
	const originalUseCli = process.env.CURSOR_ACP_USE_CLI;
	const originalUseSdk = process.env.CURSOR_ACP_USE_SDK;

	afterEach(() => {
		if (originalApiKey === undefined) {
			delete process.env.CURSOR_API_KEY;
		} else {
			process.env.CURSOR_API_KEY = originalApiKey;
		}
		if (originalUseCli === undefined) {
			delete process.env.CURSOR_ACP_USE_CLI;
		} else {
			process.env.CURSOR_ACP_USE_CLI = originalUseCli;
		}
		if (originalUseSdk === undefined) {
			delete process.env.CURSOR_ACP_USE_SDK;
		} else {
			process.env.CURSOR_ACP_USE_SDK = originalUseSdk;
		}
	});

	it("prefers SDK when CURSOR_API_KEY is set", () => {
		process.env.CURSOR_API_KEY = "test-key";
		delete process.env.CURSOR_ACP_USE_CLI;
		delete process.env.CURSOR_ACP_USE_SDK;
		expect(shouldUseCursorSdk()).toBe(true);
		expect(getCursorApiKey()).toBe("test-key");
	});

	it("forces CLI when CURSOR_ACP_USE_CLI=1", () => {
		process.env.CURSOR_API_KEY = "test-key";
		process.env.CURSOR_ACP_USE_CLI = "1";
		expect(shouldUseCursorSdk()).toBe(false);
	});

	it("disables SDK when CURSOR_ACP_USE_SDK=0", () => {
		delete process.env.CURSOR_API_KEY;
		process.env.CURSOR_ACP_USE_SDK = "0";
		expect(shouldUseCursorSdk()).toBe(false);
	});
});
