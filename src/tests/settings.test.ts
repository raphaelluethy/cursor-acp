import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDefaultMode, parseDefaultModel } from "../settings.js";

const originalConfigDir = process.env.CURSOR_ACP_CONFIG_DIR;
const originalDefaultMode = process.env.CURSOR_ACP_DEFAULT_MODE;
const originalDefaultModel = process.env.CURSOR_ACP_DEFAULT_MODEL;

describe("settings defaults", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cursor-acp-settings-"));
		process.env.CURSOR_ACP_CONFIG_DIR = tempDir;
		delete process.env.CURSOR_ACP_DEFAULT_MODE;
		delete process.env.CURSOR_ACP_DEFAULT_MODEL;
	});

	afterEach(async () => {
		if (originalConfigDir) {
			process.env.CURSOR_ACP_CONFIG_DIR = originalConfigDir;
		} else {
			delete process.env.CURSOR_ACP_CONFIG_DIR;
		}
		if (originalDefaultMode !== undefined) {
			process.env.CURSOR_ACP_DEFAULT_MODE = originalDefaultMode;
		} else {
			delete process.env.CURSOR_ACP_DEFAULT_MODE;
		}
		if (originalDefaultModel !== undefined) {
			process.env.CURSOR_ACP_DEFAULT_MODEL = originalDefaultModel;
		} else {
			delete process.env.CURSOR_ACP_DEFAULT_MODEL;
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

	it("prefers CURSOR_ACP_DEFAULT_MODE over config file", async () => {
		await fs.promises.writeFile(
			path.join(tempDir, "config.json"),
			JSON.stringify({ default_mode: "yolo" }),
			"utf-8",
		);
		process.env.CURSOR_ACP_DEFAULT_MODE = "plan";
		expect(parseDefaultMode()).toBe("plan");
	});

	it("prefers CURSOR_ACP_DEFAULT_MODEL over config file", async () => {
		await fs.promises.writeFile(
			path.join(tempDir, "config.json"),
			JSON.stringify({ default_model: "from-file" }),
			"utf-8",
		);
		process.env.CURSOR_ACP_DEFAULT_MODEL = "from-env";
		expect(parseDefaultModel()).toBe("from-env");
	});
});
