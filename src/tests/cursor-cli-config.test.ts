import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	collectProjectCliConfigPaths,
	loadCursorCliConfig,
	shellCommandHasCommitAttribution,
} from "../cursor-cli-config.js";

const originalConfigDir = process.env.CURSOR_CONFIG_DIR;

afterEach(() => {
	if (originalConfigDir === undefined) {
		delete process.env.CURSOR_CONFIG_DIR;
	} else {
		process.env.CURSOR_CONFIG_DIR = originalConfigDir;
	}
});

describe("cursor-cli-config", () => {
	it("merges project cli.json over user cli-config attribution", () => {
		const root = mkdtempSync(join(tmpdir(), "cursor-cli-config-"));
		const configDir = join(root, "config");
		const repo = join(root, "repo");
		mkdirSync(configDir, { recursive: true });
		mkdirSync(join(repo, ".cursor"), { recursive: true });
		mkdirSync(join(repo, ".git"), { recursive: true });

		process.env.CURSOR_CONFIG_DIR = configDir;
		writeFileSync(
			join(configDir, "cli-config.json"),
			JSON.stringify({
				attribution: { attributeCommitsToAgent: true, attributePRsToAgent: true },
			}),
		);
		writeFileSync(
			join(repo, ".cursor", "cli.json"),
			JSON.stringify({
				attribution: { attributeCommitsToAgent: false, attributePRsToAgent: false },
			}),
		);

		const loaded = loadCursorCliConfig(repo);
		expect(loaded.attribution.attributeCommitsToAgent).toBe(false);
		expect(loaded.attribution.attributePRsToAgent).toBe(false);
		expect(collectProjectCliConfigPaths(repo)).toEqual([join(repo, ".cursor", "cli.json")]);
	});

	it("detects commit attribution shell flags", () => {
		expect(
			shellCommandHasCommitAttribution(
				'git commit --trailer "Co-authored-by: Cursor <cursoragent@cursor.com>" -m "feat: test"',
			),
		).toBe(true);
		expect(shellCommandHasCommitAttribution('git commit -m "feat: test"')).toBe(false);
	});
});
