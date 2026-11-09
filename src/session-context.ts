import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSupplementalSkills } from "./skills.js";
import type { Logger } from "./utils.js";

function stripFrontmatter(markdown: string): string {
	return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}

export async function buildFirstTurnContext(
	workspace: string,
	homeDirectory: string = os.homedir(),
	logger: Pick<Logger, "warn"> = console,
): Promise<string> {
	const parts: string[] = [];
	const rulesPath = path.join(homeDirectory, ".agents", "AGENTS.md");
	try {
		const realPath = await fs.realpath(rulesPath);
		const rules = stripFrontmatter(await fs.readFile(realPath, "utf8"));
		if (rules) parts.push(`User rules from ${realPath}:\n${rules}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			logger.warn?.(`[cursor-acp] Unable to read user rules ${rulesPath}`, error);
		}
	}

	const skills = await loadSupplementalSkills(workspace, homeDirectory, logger);
	if (skills.length > 0) {
		parts.push(
			[
				"Additional skills available for automatic use. When a task matches, read the SKILL.md file before following it:",
				...skills.map(
					(skill) =>
						`- ${skill.name}: ${skill.description} (SKILL.md: ${skill.sourcePath})`,
				),
			].join("\n"),
		);
	}
	return parts.length > 0
		? `<cursor_acp_user_context>\n${parts.join("\n\n")}\n</cursor_acp_user_context>`
		: "";
}
