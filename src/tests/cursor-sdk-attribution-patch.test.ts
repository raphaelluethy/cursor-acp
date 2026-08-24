import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ATTRIBUTION_ENV_NAMES = [
	"CURSOR_ACP_ATTRIBUTE_COMMITS_TO_AGENT",
	"CURSOR_ACP_ATTRIBUTE_PRS_TO_AGENT",
] as const;

function runtimeSources(directory: string): string {
	return readdirSync(directory)
		.filter((name) => name.endsWith(".js"))
		.map((name) => readFileSync(join(directory, name), "utf8"))
		.join("\n");
}

describe("patched Cursor SDK attribution fallback", () => {
	it("ships the cursor-acp attribution override in every JavaScript runtime variant", () => {
		const esmEntry = fileURLToPath(import.meta.resolve("@cursor/sdk"));
		const distDirectory = resolve(dirname(esmEntry), "..");
		const variants = [
			runtimeSources(join(distDirectory, "esm")),
			runtimeSources(join(distDirectory, "cjs")),
			readFileSync(join(distDirectory, "bundled", "index.js"), "utf8"),
		];

		for (const source of variants) {
			for (const envName of ATTRIBUTION_ENV_NAMES) {
				const envIndex = source.indexOf(envName);
				expect(
					envIndex,
					`${envName} is missing from an SDK runtime variant`,
				).toBeGreaterThan(-1);
				expect(
					source.slice(Math.max(0, envIndex - 300), envIndex + envName.length + 100),
				).toContain("attribute");
			}
		}
	});
});
