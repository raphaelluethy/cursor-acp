import { describe, expect, it } from "vitest";
import {
  parseLeadingSlashCommand,
  promptToCursorText,
  rewriteMcpSlashCommand,
} from "../prompt-conversion.js";

describe("prompt conversion", () => {
  it("rewrites mcp slash command", () => {
    expect(rewriteMcpSlashCommand("/mcp:server:name args")).toBe(
      "/server:name (MCP) args",
    );
    expect(rewriteMcpSlashCommand("/compact")).toBe("/compact");
  });

  it("converts resources and mentions", () => {
    const text = promptToCursorText({
      sessionId: "s1",
      prompt: [
        { type: "text", text: "Please inspect" },
        {
          type: "resource_link",
          name: "bar.ts",
          uri: "file:///tmp/foo/bar.ts",
        },
        {
          type: "resource",
          resource: {
            uri: "file:///tmp/foo/baz.ts",
            text: "const x = 1;",
            mimeType: "text/plain",
          },
        },
      ],
    } as any);

    expect(text).toContain("Please inspect");
    expect(text).toContain("@bar.ts (file:///tmp/foo/bar.ts)");
    expect(text).toContain("@baz.ts (file:///tmp/foo/baz.ts)");
    expect(text).toContain('<context ref="file:///tmp/foo/baz.ts">');
  });

  it("parses slash command arguments after newline", () => {
    const parsed = parseLeadingSlashCommand("/commit\nfeat(parser)");
    expect(parsed).toEqual({
      hasSlash: true,
      command: "commit",
      args: "feat(parser)",
      raw: "/commit\nfeat(parser)",
    });
  });
});
