import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { Logger } from "./utils.js";

/** Attachment file written for a non-text block in a steer prompt. */
export interface SteerAttachmentFile {
	path: string;
	mimeType: string;
}

/** A steer prompt converted to text, with attachments replaced by file references. */
export interface SteerPromptText {
	text: string;
	attachments: SteerAttachmentFile[];
}

/** Steer attachments live under the system temp dir, one subdirectory per session. */
export const STEER_ATTACHMENTS_DIR_NAME = "cursor-acp-attachments";
/** Session attachment dirs are removed when older than this. */
export const STEER_ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const MIME_EXTENSIONS: Record<string, string> = {
	"application/json": ".json",
	"application/octet-stream": ".bin",
	"application/pdf": ".pdf",
	"application/xml": ".xml",
	"application/zip": ".zip",
	"audio/mpeg": ".mp3",
	"audio/wav": ".wav",
	"audio/wave": ".wav",
	"image/bmp": ".bmp",
	"image/gif": ".gif",
	"image/jpeg": ".jpg",
	"image/jpg": ".jpg",
	"image/png": ".png",
	"image/svg+xml": ".svg",
	"image/tiff": ".tiff",
	"image/webp": ".webp",
	"text/csv": ".csv",
	"text/css": ".css",
	"text/html": ".html",
	"text/markdown": ".md",
	"text/plain": ".txt",
	"video/mp4": ".mp4",
};

const DEFAULT_MIME_TYPE = "application/octet-stream";

/** Session ids come from ACP clients; keep only safe path characters. */
export function sanitizeSessionId(sessionId: string): string {
	const safe = sessionId
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.replace(/\.{2,}/g, "_")
		.replace(/^\.+/, "_");
	return safe.length > 0 ? safe.slice(0, 128) : "session";
}

export function steerAttachmentsRootDir(tmpDir: string = os.tmpdir()): string {
	return path.join(tmpDir, STEER_ATTACHMENTS_DIR_NAME);
}

export function steerSessionDir(sessionId: string, tmpDir: string = os.tmpdir()): string {
	return path.join(steerAttachmentsRootDir(tmpDir), sanitizeSessionId(sessionId));
}

/** Extension matching the MIME type so the agent can open the file by name. */
export function extensionForMimeType(mimeType: string | undefined): string {
	if (!mimeType) {
		return ".bin";
	}
	const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
	return MIME_EXTENSIONS[normalized] ?? `.${subtypeExtension(normalized)}`;
}

function subtypeExtension(normalized: string): string {
	const subtype = normalized.split("/")[1] ?? "";
	const safe = subtype.replace(/[^a-z0-9.+_-]/gi, "");
	return safe.length > 0 ? safe : "bin";
}

/** Fixed-format reference line that replaces an attachment in a steer prompt. */
export function steerAttachmentReferenceLine(attachment: SteerAttachmentFile): string {
	return `[attachment: ${attachment.path} (MIME: ${attachment.mimeType}) — use the read-file tool to view it if needed]`;
}

/**
 * Convert a steer prompt's content blocks into a single steer text.
 *
 * Text blocks are kept verbatim, in order. Image blocks and embedded resource
 * blocks are written to the session's attachment directory (mode 0700 dir,
 * 0600 files) and replaced by one fixed-format reference line each. Resource
 * link blocks are replaced by a text line with their URI.
 */
export async function buildSteerPromptText(
	sessionId: string,
	blocks: ContentBlock[],
	tmpDir: string = os.tmpdir(),
): Promise<SteerPromptText> {
	const lines: string[] = [];
	const attachments: SteerAttachmentFile[] = [];

	for (const block of blocks) {
		switch (block.type) {
			case "text": {
				lines.push(block.text);
				break;
			}
			case "image": {
				if (block.data) {
					const mimeType = block.mimeType || DEFAULT_MIME_TYPE;
					const file = await writeSteerAttachment(
						sessionId,
						Buffer.from(block.data, "base64"),
						mimeType,
						tmpDir,
					);
					attachments.push(file);
					lines.push(steerAttachmentReferenceLine(file));
				} else if (block.uri) {
					lines.push(`[image: ${block.uri}]`);
				}
				break;
			}
			case "resource": {
				const { uri, mimeType } = block.resource;
				if ("text" in block.resource) {
					const resolvedMime = mimeType || "text/plain";
					const file = await writeSteerAttachment(
						sessionId,
						Buffer.from(block.resource.text, "utf8"),
						resolvedMime,
						tmpDir,
					);
					attachments.push(file);
					lines.push(steerAttachmentReferenceLine(file));
				} else if ("blob" in block.resource) {
					const resolvedMime = mimeType || DEFAULT_MIME_TYPE;
					const file = await writeSteerAttachment(
						sessionId,
						Buffer.from(block.resource.blob, "base64"),
						resolvedMime,
						tmpDir,
					);
					attachments.push(file);
					lines.push(steerAttachmentReferenceLine(file));
				} else {
					lines.push(uri);
				}
				break;
			}
			case "resource_link": {
				lines.push(block.uri);
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

	return { text: lines.join("\n\n").trim(), attachments };
}

async function writeSteerAttachment(
	sessionId: string,
	content: Buffer,
	mimeType: string,
	tmpDir: string,
): Promise<SteerAttachmentFile> {
	const dir = steerSessionDir(sessionId, tmpDir);
	// TODO(review): on Linux with a shared /tmp, `recursive` also creates the
	// shared root (cursor-acp-attachments) as 0700 owned by the first user, so
	// other users on the host get EACCES. If another user pre-creates the root
	// they own it and could swap a session dir for a symlink between chmod and
	// writeFile. Use a per-user root (e.g. include the uid) or mkdtemp, and
	// verify ownership of the root before writing.
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700);
	const file = path.join(
		dir,
		`attachment-${randomUUID().replace(/-/g, "").slice(0, 12)}${extensionForMimeType(mimeType)}`,
	);
	await writeFile(file, content, { mode: 0o600 });
	await chmod(file, 0o600);
	return { path: file, mimeType };
}

/** Remove a session's attachment directory and everything in it. */
export async function cleanupSessionSteerAttachments(
	sessionId: string,
	tmpDir: string = os.tmpdir(),
): Promise<void> {
	await rm(steerSessionDir(sessionId, tmpDir), {
		recursive: true,
		force: true,
		// In-flight attachment writes can recreate files while the removal is
		// running; retry so a racing writer cannot leave the directory behind.
		maxRetries: 10,
		retryDelay: 20,
	});
}

/**
 * Remove attachment directories that have not been written to for longer than
 * `maxAgeMs`. Covers sessions whose adapter process ended without an explicit
 * close. Returns the number of directories removed.
 */
// TODO(review): the mtime sweep can delete the directory of a session that is
// still live in another adapter process but has not written an attachment in
// the last 24h.
export async function cleanupExpiredSteerAttachments(
	maxAgeMs: number = STEER_ATTACHMENT_MAX_AGE_MS,
	tmpDir: string = os.tmpdir(),
): Promise<number> {
	const root = steerAttachmentsRootDir(tmpDir);
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return 0;
	}
	const cutoff = Date.now() - maxAgeMs;
	let removed = 0;
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const dir = path.join(root, entry.name);
		try {
			const info = await stat(dir);
			if (info.mtimeMs < cutoff) {
				await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
				removed += 1;
			}
		} catch {
			// Another process may have removed it concurrently; ignore.
		}
	}
	return removed;
}

let expiredCleanupStarted = false;

/** Run the expired-attachment cleanup once per adapter process. */
export function startExpiredSteerAttachmentCleanup(logger: Logger): void {
	if (expiredCleanupStarted) {
		return;
	}
	expiredCleanupStarted = true;
	void cleanupExpiredSteerAttachments().catch((error: unknown) => {
		logger.error("[cursor-acp] failed to clean expired steer attachments", error);
	});
}
