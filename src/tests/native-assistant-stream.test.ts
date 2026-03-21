import { describe, expect, it } from "vitest";
import {
	appendAssistantTextFromNativeChunk,
	formatTurnRecapMarkdown,
	recordTurnArtifactsFromNativeSessionUpdate,
} from "../native-assistant-stream.js";

describe("appendAssistantTextFromNativeChunk", () => {
	it("collects plain text chunks", () => {
		const chunks: string[] = [];
		appendAssistantTextFromNativeChunk(
			{
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "hello" },
			},
			chunks,
		);
		expect(chunks).toEqual(["hello"]);
	});

	it("collects resource_link chunks", () => {
		const chunks: string[] = [];
		appendAssistantTextFromNativeChunk(
			{
				sessionUpdate: "agent_message_chunk",
				content: { type: "resource_link", name: "main.go", uri: "file:///p/main.go" },
			},
			chunks,
		);
		expect(chunks).toEqual(["[main.go](file:///p/main.go)"]);
	});
});

describe("recordTurnArtifactsFromNativeSessionUpdate", () => {
	it("records completed edit updates", () => {
		const artifacts: any[] = [];
		recordTurnArtifactsFromNativeSessionUpdate(artifacts, {
			sessionUpdate: "tool_call_update",
			status: "completed",
			kind: "edit",
			title: "Edit foo.go",
			locations: [{ path: "/proj/foo.go" }],
		});
		expect(artifacts).toEqual([
			{ kind: "edit", title: "Edit foo.go", paths: ["/proj/foo.go"] },
		]);
	});
});

describe("formatTurnRecapMarkdown", () => {
	it("formats file groups and shell output like a short composer recap", () => {
		const md = formatTurnRecapMarkdown([
			{
				kind: "edit",
				title: "Calls LoadConfig(sugar) after logger init",
				paths: ["/svc/main.go"],
			},
			{
				kind: "execute",
				title: "`go build`",
				paths: [],
				shellOutput: "go build for device-service succeeds.",
			},
		]);
		expect(md).toContain("**main.go**");
		expect(md).toContain("LoadConfig");
		expect(md).toContain("go build for device-service succeeds.");
	});
});
