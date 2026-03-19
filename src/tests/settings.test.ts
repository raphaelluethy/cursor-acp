import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDefaultMode, parseDefaultModel } from "../settings.js";

const originalConfigDir = process.env.CURSOR_ACP_CONFIG_DIR;

describe("settings defaults", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cursor-acp-settings-"));
		process.env.CURSOR_ACP_CONFIG_DIR = tempDir;
	});

	afterEach(async () => {
		if (originalConfigDir) {
			process.env.CURSOR_ACP_CONFIG_DIR = originalConfigDir;
		} else {
			delete process.env.CURSOR_ACP_CONFIG_DIR;
		}
		await fs.promises.rm(tempDir, { recursive: true, force: true });
	});

	it("reads default_mode from config.json", async () => {
		await fs.promises.writeFile(
			path.join(tempDir, "config.json"),
			JSON.stringify({ default_mode: "yolo" }),
			"utf-8",
		);
		expect(parseDefaultMode()).toBe("yolo");
	});

	it("reads default_model from config.json", async () => {
		await fs.promises.writeFile(
			path.join(tempDir, "config.json"),
			JSON.stringify({ default_model: "gpt-4.1" }),
			"utf-8",
		);
		expect(parseDefaultModel()).toBe("gpt-4.1");
	});
});
