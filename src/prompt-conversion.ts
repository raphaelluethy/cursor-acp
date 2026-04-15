import { PromptRequest } from "@agentclientprotocol/sdk";

function basenameFromUri(uri: string): string {
	try {
		if (uri.startsWith("file://")) {
			const url = new URL(uri);
			const parts = url.pathname.split("/").filter(Boolean);
			return parts[parts.length - 1] ?? uri;
		}
		const parsed = new URL(uri);
		const parts = parsed.pathname.split("/").filter(Boolean);
		return parts[parts.length - 1] ?? uri;
	} catch {
		const parts = uri.split("/").filter(Boolean);
		return parts[parts.length - 1] ?? uri;
	}
}

export function rewriteMcpSlashCommand(text: string): string {
	return text;
}

function formatResourceLink(uri: string): string {
	const name = basenameFromUri(uri);
	return `@${name} (${uri})`;
}

export function promptToCursorText(prompt: PromptRequest): string {
	const lines: string[] = [];
	const contexts: string[] = [];

	for (const chunk of prompt.prompt) {
		switch (chunk.type) {
			case "text": {
				lines.push(rewriteMcpSlashCommand(chunk.text));
				break;
			}
			case "resource_link": {
				lines.push(formatResourceLink(chunk.uri));
				break;
			}
			case "resource": {
				if ("text" in chunk.resource) {
					lines.push(formatResourceLink(chunk.resource.uri));
					contexts.push(
						`<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>`,
					);
				}
				break;
			}
			case "image": {
				if (chunk.uri) {
					lines.push(`[image: ${chunk.uri}]`);
				} else if (chunk.data) {
					lines.push(
						`[image data: ${chunk.mimeType || "application/octet-stream"}, ${chunk.data.length} bytes]`,
					);
				}
				break;
			}
			case "audio": {
				lines.push("[audio omitted]");
				break;
			}
			default:
				break;
		}
	}

	if (contexts.length > 0) {
		lines.push(...contexts);
	}

	return lines.join("\n\n").trim();
}

export type ParsedSlashCommand =
	| {
			hasSlash: false;
			command: null;
			args: string;
			raw: string;
	  }
	| {
			hasSlash: true;
			command: string;
			args: string;
			raw: string;
	  };

export function parseLeadingSlashCommand(text: string): ParsedSlashCommand {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) {
		return { hasSlash: false, command: null, args: trimmed, raw: text };
	}

	const withoutSlash = trimmed.slice(1);
	if (withoutSlash.length === 0) {
		return {
			hasSlash: true,
			command: "",
			args: "",
			raw: text,
		};
	}

	const firstWhitespace = withoutSlash.search(/\s/);
	const command =
		firstWhitespace === -1 ? withoutSlash : withoutSlash.slice(0, Math.max(firstWhitespace, 0));
	let args = firstWhitespace === -1 ? "" : withoutSlash.slice(firstWhitespace).trim();
	if (args.toUpperCase() === "(MCP)") {
		args = "";
	} else if (args.toUpperCase().startsWith("(MCP) ")) {
		args = args.slice("(MCP)".length).trim();
	}

	return {
		hasSlash: true,
		command,
		args,
		raw: text,
	};
}
