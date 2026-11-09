import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildFirstTurnContext } from "../session-context.js";

describe("first-turn SDK context", () => {
	it("follows the global rules link and lists only missing automatic skills", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-context-"));
		const home = path.join(root, "home");
		const workspace = path.join(root, "workspace");
		const userSkills = path.join(home, ".agents", "skills");
		const nativeSkill = path.join(home, ".cursor", "skills-cursor", "native");
		const tdd = path.join(root, "shared", "tdd");
		const disabled = path.join(root, "shared", "ppt-visual-review");
		const rules = path.join(root, "user-agents.md");
		for (const dir of [userSkills, nativeSkill, tdd, disabled, workspace]) {
			await mkdir(dir, { recursive: true });
		}
		await writeFile(
			rules,
			"---\nalwaysApply: true\n---\nWhen a named skill is missing, inspect ~/.agents/skills.",
		);
		await symlink(rules, path.join(home, ".agents", "AGENTS.md"));
		await writeFile(
			path.join(tdd, "SKILL.md"),
			"---\nname: tdd\ndescription: Test first\n---\nTDD body",
		);
		await writeFile(
			path.join(disabled, "SKILL.md"),
			"---\nname: ppt-visual-review\ndescription: Review slides\ndisable-model-invocation: true\n---\nPPT body",
		);
		await writeFile(
			path.join(nativeSkill, "SKILL.md"),
			"---\nname: native\ndescription: Built in\n---\nNative body",
		);
		await symlink(tdd, path.join(userSkills, "tdd"));
		await symlink(disabled, path.join(userSkills, "ppt-visual-review"));
		await symlink(nativeSkill, path.join(userSkills, "native-alias"));

		try {
			const context = await buildFirstTurnContext(workspace, home);
			expect(context).toContain(`User rules from ${rules}:`);
			expect(context).toContain("When a named skill is missing, inspect ~/.agents/skills.");
			expect(context).not.toContain("alwaysApply:");
			expect(context).toContain(`tdd: Test first (SKILL.md: ${path.join(tdd, "SKILL.md")})`);
			expect(context).not.toContain("ppt-visual-review");
			expect(context).not.toContain("native:");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
