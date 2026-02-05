import { describe, expect, it } from "vitest";
import { ToolCallContent } from "@agentclientprotocol/sdk";
import { toolUpdateFromCursorToolResult } from "../tools.js";

function textFromContent(content: ToolCallContent[] | undefined): string {
    const first = content?.[0];
    if (
        first &&
        first.type === "content" &&
        first.content?.type === "text" &&
        typeof first.content.text === "string"
    ) {
        return first.content.text;
    }
    return "";
}

describe("toolUpdateFromCursorToolResult", () => {
    it("includes stdout and stderr output", () => {
        const update = toolUpdateFromCursorToolResult(
            "shellToolCall",
            { command: "ls" },
            {
                success: {
                    stdout: "line1\n",
                    stderr: "warn\n",
                },
            },
        );

        const text = textFromContent(update.content);
        expect(text).toContain("line1");
        expect(text).toContain("warn");
        expect(text.startsWith("```\n")).toBe(true);
    });

    it("falls back to content/text fields", () => {
        const update = toolUpdateFromCursorToolResult(
            "readToolCall",
            { path: "/tmp/file" },
            {
                success: {
                    content: "hello world",
                },
            },
        );

        const text = textFromContent(update.content);
        expect(text).toContain("hello world");
    });

    it("uses interleaved output when present", () => {
        const update = toolUpdateFromCursorToolResult(
            "shellToolCall",
            { command: "echo hi" },
            {
                success: {
                    interleavedOutput: "hi\n",
                    stdout: "",
                    stderr: "",
                },
            },
        );

        const text = textFromContent(update.content);
        expect(text).toContain("hi");
    });
});
