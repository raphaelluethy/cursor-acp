import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyCursorCliAttributionEnvironment,
	collectProjectCliConfigPaths,
	CURSOR_ACP_ATTRIBUTE_COMMITS_ENV,
	CURSOR_ACP_ATTRIBUTE_PRS_ENV,
	loadCursorCliConfig,
	shellCommandHasCommitAttribution,
} from "../cursor-cli-config.js";

const originalConfigDir = process.env.CURSOR_CONFIG_DIR;
const originalCommitAttribution = process.env[CURSOR_ACP_ATTRIBUTE_COMMITS_ENV];
const originalPrAttribution = process.env[CURSOR_ACP_ATTRIBUTE_PRS_ENV];

afterEach(() => {
	if (originalConfigDir === undefined) {
		delete process.env.CURSOR_CONFIG_DIR;
	} else {
		process.env.CURSOR_CONFIG_DIR = originalConfigDir;
	}
	if (originalCommitAttribution === undefined) {
		delete process.env[CURSOR_ACP_ATTRIBUTE_COMMITS_ENV];
	} else {
		process.env[CURSOR_ACP_ATTRIBUTE_COMMITS_ENV] = originalCommitAttribution;
	}
	if (originalPrAttribution === undefined) {
		delete process.env[CURSOR_ACP_ATTRIBUTE_PRS_ENV];
	} else {
		process.env[CURSOR_ACP_ATTRIBUTE_PRS_ENV] = originalPrAttribution;
	}
});

describe("cursor-cli-config", () => {
	it("uses global attribution because project cli.json only supports permissions", () => {
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
				attribution: { attributeCommitsToAgent: false, attributePRsToAgent: false },
			}),
		);
		writeFileSync(
			join(repo, ".cursor", "cli.json"),
			JSON.stringify({
				attribution: { attributeCommitsToAgent: true, attributePRsToAgent: true },
			}),
		);

		const loaded = loadCursorCliConfig(repo);
		expect(loaded.attribution.attributeCommitsToAgent).toBe(false);
		expect(loaded.attribution.attributePRsToAgent).toBe(false);
		expect(collectProjectCliConfigPaths(repo)).toEqual([join(repo, ".cursor", "cli.json")]);
	});

	it("exports resolved attribution for the patched SDK runtime", () => {
		const root = mkdtempSync(join(tmpdir(), "cursor-cli-attribution-"));
		const configDir = join(root, "config");
		mkdirSync(configDir, { recursive: true });
		process.env.CURSOR_CONFIG_DIR = configDir;
		writeFileSync(
			join(configDir, "cli-config.json"),
			JSON.stringify({
				attribution: { attributeCommitsToAgent: false, attributePRsToAgent: true },
			}),
		);

		const loaded = applyCursorCliAttributionEnvironment(root);

		expect(loaded.attribution).toEqual({
			attributeCommitsToAgent: false,
			attributePRsToAgent: true,
		});
		expect(process.env[CURSOR_ACP_ATTRIBUTE_COMMITS_ENV]).toBe("false");
		expect(process.env[CURSOR_ACP_ATTRIBUTE_PRS_ENV]).toBe("true");
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
