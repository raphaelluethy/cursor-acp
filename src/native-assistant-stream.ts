import { basename } from "node:path";
import type { ToolKind } from "@agentclientprotocol/sdk";
import { isObject } from "./utils.js";

/**
 * Cursor ACP may stream assistant-visible text in `agent_message_chunk` blocks whose
 * `content` is not always `{ type: "text", text }`. Collect any text we can represent.
 */
export function appendAssistantTextFromNativeChunk(
	update: { sessionUpdate?: string; content?: unknown },
	chunks: string[],
): void {
	if (update.sessionUpdate !== "agent_message_chunk") {
		return;
	}
	const text = textFromContentBlock(update.content);
	if (text.length > 0) {
		chunks.push(text);
	}
}

function textFromContentBlock(block: unknown): string {
	if (!isObject(block)) {
		return "";
	}
	const type = block.type;
	if (type === "text" && typeof block.text === "string") {
		return block.text;
	}
	if (type === "resource_link") {
		const name = typeof block.name === "string" ? block.name : "";
		const uri = typeof block.uri === "string" ? block.uri : "";
		if (name && uri) {
			return `[${name}](${uri})`;
		}
		return name || uri;
	}
	return "";
}

export interface TurnArtifact {
	kind: ToolKind | undefined;
	title: string;
	paths: string[];
	shellOutput?: string;
}

function pushArtifactFromToolishUpdate(
	artifacts: TurnArtifact[],
	update: Record<string, unknown>,
): void {
	const kind = update.kind as ToolKind | undefined;
	const title = typeof update.title === "string" ? update.title : "";
	const paths = locationPaths(update.locations);

	if (kind === "edit" || kind === "delete" || kind === "move") {
		artifacts.push({ kind, title, paths });
		return;
	}

	if (kind === "execute") {
		const shellOutput = summarizeShellRawOutput(update.rawOutput);
		artifacts.push({ kind, title, paths: [], shellOutput });
	}
}

/** Record completed file/shell tools so we can synthesize a closing recap if the model streams none. */
export function recordTurnArtifactsFromNativeSessionUpdate(
	artifacts: TurnArtifact[],
	update: unknown,
): void {
	if (!isObject(update)) {
		return;
	}
	const su = update.sessionUpdate;
	if (su !== "tool_call_update" && su !== "tool_call") {
		return;
	}
	if (update.status !== "completed") {
		return;
	}
	pushArtifactFromToolishUpdate(artifacts, update);
}

function locationPaths(locations: unknown): string[] {
	if (!Array.isArray(locations)) {
		return [];
	}
	const out: string[] = [];
	for (const loc of locations) {
		if (isObject(loc) && typeof loc.path === "string" && loc.path.length > 0) {
			out.push(loc.path);
		}
	}
	return out;
}

function summarizeShellRawOutput(raw: unknown): string | undefined {
	if (typeof raw === "string" && raw.trim().length > 0) {
		const lines = raw.trim().split(/\r?\n/).filter(Boolean);
		return lines.slice(-5).join("\n");
	}
	if (!isObject(raw)) {
		return undefined;
	}
	const success = raw.success;
	if (!isObject(success)) {
		return undefined;
	}
	for (const key of ["interleavedOutput", "stdout", "stderr"] as const) {
		const v = success[key];
		if (typeof v === "string" && v.trim().length > 0) {
			const lines = v.trim().split(/\r?\n/).filter(Boolean);
			return lines.slice(-5).join("\n");
		}
	}
	return undefined;
}

/** Composer-style recap when the model did not stream a closing summary. */
export function formatTurnRecapMarkdown(artifacts: TurnArtifact[]): string {
	if (artifacts.length === 0) {
		return "";
	}

	const pathToBullets = new Map<string, Set<string>>();
	const shellParagraphs: string[] = [];

	for (const a of artifacts) {
		if (a.kind === "execute") {
			const bit = a.shellOutput?.trim() || a.title.trim();
			if (bit.length > 0) {
				shellParagraphs.push(bit);
			}
			continue;
		}

		const bullet = a.title.trim() || "Changes applied";
		const paths = a.paths.length > 0 ? a.paths : [""];
		for (const p of paths) {
			const key = p.length > 0 ? p : "";
			if (!pathToBullets.has(key)) {
				pathToBullets.set(key, new Set());
			}
			pathToBullets.get(key)!.add(bullet);
		}
	}

	const parts: string[] = [];

	const sortedPaths = [...pathToBullets.keys()].sort((a, b) => {
		if (a === "") {
			return 1;
		}
		if (b === "") {
			return -1;
		}
		return a.localeCompare(b);
	});

	for (const pathKey of sortedPaths) {
		const bullets = pathToBullets.get(pathKey)!;
		const heading = pathKey.length > 0 ? basename(pathKey) : "Updates";
		parts.push(`**${heading}**`, "");
		for (const b of bullets) {
			parts.push(`- ${b}`);
		}
		parts.push("");
	}

	for (const s of shellParagraphs) {
		parts.push(s, "");
	}

	return parts.join("\n").trimEnd();
}
