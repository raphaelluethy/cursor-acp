import { describe, expect, it } from "vitest";
import { parseAuthStatus } from "../auth.js";

describe("parseAuthStatus", () => {
  it("parses logged in output", () => {
    const parsed = parseAuthStatus("✓ Logged in as user@example.com");
    expect(parsed.loggedIn).toBe(true);
    if (parsed.loggedIn) {
      expect(parsed.account).toBe("user@example.com");
    }
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
    if (parsed.loggedIn) {
      expect(parsed.account).toBe("me@site.com");
    }
  });
});
