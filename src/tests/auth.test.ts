import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CursorAuth, parseAuthStatus } from "../auth.js";

const sdkMocks = vi.hoisted(() => ({
	login: vi.fn(),
	logout: vi.fn(),
	status: vi.fn(),
	me: vi.fn(),
}));

vi.mock("@cursor/sdk", () => ({
	Cursor: {
		auth: { login: sdkMocks.login, logout: sdkMocks.logout, status: sdkMocks.status },
		me: sdkMocks.me,
	},
}));

const originalApiKey = process.env.CURSOR_API_KEY;

beforeEach(() => {
	vi.clearAllMocks();
	delete process.env.CURSOR_API_KEY;
	sdkMocks.status.mockResolvedValue({ status: "logged-out" });
});

afterEach(() => {
	if (originalApiKey === undefined) delete process.env.CURSOR_API_KEY;
	else process.env.CURSOR_API_KEY = originalApiKey;
});

describe("parseAuthStatus", () => {
	it("parses logged in output", () => {
		const parsed = parseAuthStatus("✓ Logged in as user@example.com");
		expect(parsed.loggedIn).toBe(true);
		expect((parsed as { loggedIn: true; account: string }).account).toBe("user@example.com");
	});

	it("parses not logged in output", () => {
		const parsed = parseAuthStatus("Not logged in");
		expect(parsed.loggedIn).toBe(false);
	});

	it("handles ansi and spinner output", () => {
		const parsed = parseAuthStatus(
			"\u001b[2K\u001b[GChecking...\n\u001b[2K\n✓ Logged in as me@site.com\n",
		);
		expect(parsed.loggedIn).toBe(true);
		expect((parsed as { loggedIn: true; account: string }).account).toBe("me@site.com");
	});
});

describe("CursorAuth", () => {
	it("uses persisted SDK login status", async () => {
		sdkMocks.status.mockResolvedValue({ status: "logged-in", email: "user@example.com" });

		await expect(new CursorAuth().status()).resolves.toMatchObject({
			loggedIn: true,
			account: "user@example.com",
		});
	});

	it("logs in through the SDK without exposing the minted key", async () => {
		sdkMocks.login.mockResolvedValue({
			apiKey: "secret-key",
			email: "user@example.com",
			apiKeyExpiresAtMs: Date.now() + 1_000,
		});

		const result = await new CursorAuth().login();

		expect(sdkMocks.login).toHaveBeenCalledWith({ apiKeyName: "cursor-acp" });
		expect(result.stdout).toContain("user@example.com");
		expect(result.stdout).not.toContain("secret-key");
	});
});
