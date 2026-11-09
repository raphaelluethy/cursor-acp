import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	buildSteerPromptText,
	cleanupExpiredSteerAttachments,
	cleanupSessionSteerAttachments,
	extensionForMimeType,
	steerAttachmentReferenceLine,
	steerAttachmentsRootDir,
	steerSessionDir,
	sanitizeSessionId,
} from "../steer-attachments.js";

describe("steer attachments", () => {
	let tmpDir: string | undefined;

	afterEach(async () => {
		if (tmpDir) {
			await rm(tmpDir, { recursive: true, force: true });
			tmpDir = undefined;
		}
	});

	async function createIsolatedTmpDir(): Promise<string> {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-steer-test-"));
		return tmpDir;
	}

	it("maps MIME types to file extensions", () => {
		expect(extensionForMimeType("image/png")).toBe(".png");
		expect(extensionForMimeType("image/jpeg")).toBe(".jpg");
		expect(extensionForMimeType("text/markdown")).toBe(".md");
		expect(extensionForMimeType("application/json")).toBe(".json");
		expect(extensionForMimeType("text/plain; charset=utf-8")).toBe(".txt");
		expect(extensionForMimeType("image/unknown-kind")).toBe(".unknown-kind");
		expect(extensionForMimeType("application/octet-stream")).toBe(".bin");
		expect(extensionForMimeType(undefined)).toBe(".bin");
	});

	it("formats attachment reference lines with path, MIME type, and read-file hint", () => {
		expect(
			steerAttachmentReferenceLine({
				path: "/tmp/attachment-abc.png",
				mimeType: "image/png",
			}),
		).toBe(
			"[attachment: /tmp/attachment-abc.png (MIME: image/png) — use the read-file tool to view it if needed]",
		);
	});

	it("keeps text-only steer prompts free of files and directories", async () => {
		const isolated = await createIsolatedTmpDir();
		const result = await buildSteerPromptText(
			"session-text-only",
			[{ type: "text", text: "plain text" }],
			isolated,
		);
		expect(result.text).toBe("plain text");
		expect(result.attachments).toEqual([]);
		expect(existsSync(steerSessionDir("session-text-only", isolated))).toBe(false);
		expect(existsSync(steerAttachmentsRootDir(isolated))).toBe(false);
	});

	it("converts image, resource, and link blocks while preserving order", async () => {
		const isolated = await createIsolatedTmpDir();
		const result = await buildSteerPromptText(
			"session-mixed",
			[
				{ type: "text", text: "first" },
				{
					type: "image",
					data: Buffer.from("png-bytes").toString("base64"),
					mimeType: "image/png",
				},
				{
					type: "resource",
					resource: {
						uri: "file:///blob.bin",
						blob: Buffer.from("raw-bytes").toString("base64"),
					},
				},
				{ type: "resource_link", uri: "file:///linked.md", name: "linked.md" },
				{ type: "text", text: "last" },
			],
			isolated,
		);

		const refs = [...result.text.matchAll(/\[attachment: (.+?) \(MIME: ([^)]+)\)/g)];
		expect(refs).toHaveLength(2);
		expect(refs[0]?.[2]).toBe("image/png");
		expect(refs[1]?.[2]).toBe("application/octet-stream");
		expect(result.attachments).toHaveLength(2);
		expect(result.attachments[0]?.path).toBe(refs[0]?.[1]);
		expect(result.attachments[1]?.path).toBe(refs[1]?.[1]);

		const order = [
			result.text.indexOf("first"),
			result.text.indexOf(refs[0]![0]),
			result.text.indexOf(refs[1]![0]),
			result.text.indexOf("file:///linked.md"),
			result.text.indexOf("last"),
		];
		expect([...order].sort((a, b) => a - b)).toEqual(order);

		expect(existsSync(refs[0]![1]!)).toBe(true);
		expect(refs[0]![1]!.endsWith(".png")).toBe(true);
		expect(refs[1]![1]!.endsWith(".bin")).toBe(true);
	});

	it("writes URI-only images and audio blocks as text placeholders", async () => {
		const isolated = await createIsolatedTmpDir();
		const result = await buildSteerPromptText(
			"session-uri-image",
			[
				{
					type: "image",
					data: "",
					mimeType: "image/png",
					uri: "https://example.com/cat.png",
				},
				{
					type: "audio",
					data: Buffer.from("audio").toString("base64"),
					mimeType: "audio/wav",
				},
			],
			isolated,
		);
		expect(result.text).toBe("[image: https://example.com/cat.png]\n\n[audio omitted]");
		expect(result.attachments).toEqual([]);
		expect(existsSync(steerSessionDir("session-uri-image", isolated))).toBe(false);
	});

	it("sanitizes session ids into safe directory names", () => {
		expect(sanitizeSessionId("native-1")).toBe("native-1");
		expect(sanitizeSessionId("")).toBe("session");
		for (const unsafe of ["../../etc/passwd", "..", ".", "/", "a/b/c", "a\\b"]) {
			const safe = sanitizeSessionId(unsafe);
			expect(safe).toMatch(/^[A-Za-z0-9._-]+$/);
			expect(safe).not.toContain("..");
			expect(safe.startsWith(".")).toBe(false);
		}
		expect(sanitizeSessionId("a".repeat(300))).toHaveLength(128);
	});

	it("removes the session directory on session cleanup", async () => {
		const isolated = await createIsolatedTmpDir();
		const result = await buildSteerPromptText(
			"session-cleanup",
			[{ type: "image", data: Buffer.from("x").toString("base64"), mimeType: "image/png" }],
			isolated,
		);
		expect(existsSync(result.attachments[0]?.path)).toBe(true);
		await cleanupSessionSteerAttachments("session-cleanup", isolated);
		expect(existsSync(result.attachments[0]?.path)).toBe(false);
		expect(existsSync(steerSessionDir("session-cleanup", isolated))).toBe(false);
	});

	it("removes expired session directories and keeps fresh ones", async () => {
		const isolated = await createIsolatedTmpDir();
		const root = steerAttachmentsRootDir(isolated);
		await mkdir(path.join(root, "expired"), { recursive: true });
		await mkdir(path.join(root, "fresh"), { recursive: true });
		await writeFile(path.join(root, "expired", "attachment-1.png"), "x");
		await writeFile(path.join(root, "fresh", "attachment-2.png"), "x");
		const stale = new Date(Date.now() - 48 * 60 * 60 * 1000);
		await utimes(path.join(root, "expired"), stale, stale);

		const removed = await cleanupExpiredSteerAttachments(undefined, isolated);

		expect(removed).toBe(1);
		expect(existsSync(path.join(root, "expired"))).toBe(false);
		expect(existsSync(path.join(root, "fresh"))).toBe(true);
		const remaining = await readdir(path.join(root, "fresh"));
		expect(remaining).toEqual(["attachment-2.png"]);
	});

	it("returns zero when the attachments root does not exist", async () => {
		const isolated = await createIsolatedTmpDir();
		expect(await cleanupExpiredSteerAttachments(undefined, isolated)).toBe(0);
	});
});
