import { describe, expect, it } from "vitest";
import { buildLocalAgentOptions } from "../cursor-sdk-local-options.js";
import { resolvePermissionModeSetting } from "../settings.js";

describe("permission mode setting", () => {
	it("is off unless a flag or env var opts in", () => {
		expect(resolvePermissionModeSetting([], {})).toBeUndefined();
		expect(
			resolvePermissionModeSetting([], { CURSOR_ACP_PERMISSION_MODE: " " }),
		).toBeUndefined();
	});

	it("accepts only explicit supported modes from flags", () => {
		expect(resolvePermissionModeSetting(["--permission-mode=full"], {})).toBe("full");
		expect(resolvePermissionModeSetting(["--permission-mode=accept-edits"], {})).toBe(
			"accept-edits",
		);
		expect(resolvePermissionModeSetting(["--bb-permission-mode=accept-edits"], {})).toBe(
			"accept-edits",
		);
		expect(() => resolvePermissionModeSetting(["--permission-mode=auto"], {})).toThrow();
		expect(() =>
			resolvePermissionModeSetting(
				["--permission-mode=full", "--bb-permission-mode=full"],
				{},
			),
		).toThrow();
	});

	it("reads CURSOR_ACP_PERMISSION_MODE and lets the flag win", () => {
		expect(
			resolvePermissionModeSetting([], { CURSOR_ACP_PERMISSION_MODE: "accept-edits" }),
		).toBe("accept-edits");
		expect(
			resolvePermissionModeSetting(["--permission-mode=full"], {
				CURSOR_ACP_PERMISSION_MODE: "accept-edits",
			}),
		).toBe("full");
		expect(() =>
			resolvePermissionModeSetting([], { CURSOR_ACP_PERMISSION_MODE: "yolo" }),
		).toThrow();
	});

	it("leaves the user's sandbox config in charge unless the sandbox is requested", () => {
		expect(buildLocalAgentOptions("/tmp/project", true, false)).not.toHaveProperty(
			"sandboxOptions",
		);
		expect(buildLocalAgentOptions("/tmp/project", false, true).sandboxOptions).toEqual({
			enabled: true,
		});
	});
});
