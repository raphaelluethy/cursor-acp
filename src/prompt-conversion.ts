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
  const mcpMatch = text.match(/^\/mcp:([^:\s]+):(\S+)(\s+.*)?$/);
  if (!mcpMatch) {
    return text;
  }
  const [, server, command, args] = mcpMatch;
  return `/${server}:${command} (MCP)${args || ""}`;
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

  const match = trimmed.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return {
      hasSlash: true,
      command: trimmed.slice(1),
      args: "",
      raw: text,
    };
  }

  return {
    hasSlash: true,
    command: match[1] || "",
    args: match[2]?.trim() || "",
    raw: text,
  };
}
