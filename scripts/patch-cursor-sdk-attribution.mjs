import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sdkEntry = fileURLToPath(import.meta.resolve("@cursor/sdk"));
const distDirectory = resolve(dirname(sdkEntry), "..");

const variants = [
	{
		name: "ESM",
		paths: readdirSync(join(distDirectory, "esm"))
			.filter((name) => name.endsWith(".js"))
			.map((name) => join(distDirectory, "esm", name)),
		original:
			"E=this.attributionConfigProvider?.get(),x=!y&&(E?.attribution?.attributeCommitsToAgent??!0),C=!y&&(E?.attribution?.attributePRsToAgent??!0)",
		patched:
			'E=this.attributionConfigProvider?.get(),x=!y&&(E?.attribution?.attributeCommitsToAgent??"false"!==process.env.CURSOR_ACP_ATTRIBUTE_COMMITS_TO_AGENT),C=!y&&(E?.attribution?.attributePRsToAgent??"false"!==process.env.CURSOR_ACP_ATTRIBUTE_PRS_TO_AGENT)',
	},
	{
		name: "CommonJS",
		paths: readdirSync(join(distDirectory, "cjs"))
			.filter((name) => name.endsWith(".js"))
			.map((name) => join(distDirectory, "cjs", name)),
		original:
			"E=this.attributionConfigProvider?.get(),x=!y&&(E?.attribution?.attributeCommitsToAgent??!0),C=!y&&(E?.attribution?.attributePRsToAgent??!0)",
		patched:
			'E=this.attributionConfigProvider?.get(),x=!y&&(E?.attribution?.attributeCommitsToAgent??"false"!==process.env.CURSOR_ACP_ATTRIBUTE_COMMITS_TO_AGENT),C=!y&&(E?.attribution?.attributePRsToAgent??"false"!==process.env.CURSOR_ACP_ATTRIBUTE_PRS_TO_AGENT)',
	},
	{
		name: "bundled",
		paths: [join(distDirectory, "bundled", "index.js")],
		original:
			"let P=this.attributionConfigProvider?.get();let k=U?!1:P?.attribution?.attributeCommitsToAgent??!0;let j=U?!1:P?.attribution?.attributePRsToAgent??!0",
		patched:
			'let P=this.attributionConfigProvider?.get();let k=U?!1:P?.attribution?.attributeCommitsToAgent??"false"!==process.env.CURSOR_ACP_ATTRIBUTE_COMMITS_TO_AGENT;let j=U?!1:P?.attribution?.attributePRsToAgent??"false"!==process.env.CURSOR_ACP_ATTRIBUTE_PRS_TO_AGENT',
	},
];

for (const variant of variants) {
	const originalMatches = [];
	const patchedMatches = [];

	for (const path of variant.paths) {
		const source = readFileSync(path, "utf8");
		if (source.includes(variant.original)) {
			originalMatches.push({ path, source });
		}
		if (source.includes(variant.patched)) {
			patchedMatches.push(path);
		}
	}

	if (patchedMatches.length === 1 && originalMatches.length === 0) {
		continue;
	}
	if (originalMatches.length !== 1 || patchedMatches.length !== 0) {
		throw new Error(
			`Cannot safely patch @cursor/sdk ${variant.name} attribution logic: expected one original or patched match`,
		);
	}

	const [{ path, source }] = originalMatches;
	writeFileSync(path, source.replace(variant.original, variant.patched));
}
