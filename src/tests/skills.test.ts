import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCustomSkills } from "../skills.js";

describe("skills", () => {
	it("loads skills from workspace, user, and cursor roots", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-skill-"));
		const workspace = path.join(tempRoot, "workspace");
		const home = path.join(tempRoot, "home");

		const workspaceSkill = path.join(workspace, ".cursor", "skills", "workspace-skill");
		const userSkill = path.join(home, ".agents", "skills", "user-skill");
		const cursorSkill = path.join(home, ".cursor", "skills-cursor", "cursor-skill");

		await mkdir(workspaceSkill, { recursive: true });
		await mkdir(userSkill, { recursive: true });
		await mkdir(cursorSkill, { recursive: true });

		await writeFile(
			path.join(workspaceSkill, "SKILL.md"),
			[
				"---",
				"name: workspace-skill",
				"description: Workspace skill",
				"---",
				"Workspace skill body",
			].join("\n"),
			"utf8",
		);

		await writeFile(
			path.join(userSkill, "SKILL.md"),
			["---", "name: user-skill", "description: User skill", "---", "User skill body"].join(
				"\n",
			),
			"utf8",
		);

		await writeFile(
			path.join(cursorSkill, "SKILL.md"),
			[
				"---",
				"name: cursor-skill",
				"description: Cursor skill",
				"---",
				"Cursor skill body",
			].join("\n"),
			"utf8",
		);

		try {
			const skills = await loadCustomSkills(workspace, home);
			const names = skills.map((skill) => skill.name);
			expect(names).toEqual(["cursor-skill", "user-skill", "workspace-skill"]);

			const cursor = skills.find((skill) => skill.name === "cursor-skill");
			const user = skills.find((skill) => skill.name === "user-skill");
			const workspaceSkillLoaded = skills.find((skill) => skill.name === "workspace-skill");

			expect(cursor?.origin).toBe("cursor");
			expect(user?.origin).toBe("user");
			expect(workspaceSkillLoaded?.origin).toBe("workspace");
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	it("parses folded and literal multiline descriptions", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-skill-yaml-"));
		const skillsRoot = path.join(root, ".agents", "skills");
		const folded = path.join(skillsRoot, "folded");
		const literal = path.join(skillsRoot, "literal");
		await mkdir(folded, { recursive: true });
		await mkdir(literal, { recursive: true });
		await writeFile(
			path.join(folded, "SKILL.md"),
			"---\nname: folded\ndescription: >-\n  A\n  B\n  C\n---\nBody",
		);
		await writeFile(
			path.join(literal, "SKILL.md"),
			"---\nname: literal\ndescription: |\n  First line\n  second line\n---\nBody",
		);
		try {
			const skills = await loadCustomSkills(root, path.join(root, "home"));
			expect(skills.find((skill) => skill.name === "folded")?.description).toBe("A B C");
			expect(skills.find((skill) => skill.name === "literal")?.description).toBe(
				"First line\nsecond line",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("loads child skills when a skill root also contains SKILL.md", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-skill-root-"));
		const skillsRoot = path.join(root, ".agents", "skills");
		const child = path.join(skillsRoot, "child");
		await mkdir(child, { recursive: true });
		await writeFile(path.join(skillsRoot, "SKILL.md"), "---\nname: root-skill\n---\nRoot body");
		await writeFile(path.join(child, "SKILL.md"), "---\nname: child-skill\n---\nChild body");
		try {
			expect(
				(await loadCustomSkills(root, path.join(root, "home"))).map((skill) => skill.name),
			).toEqual(["child-skill", "root-skill"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("follows directory and file links once, skips dangling links and cycles", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-skill-links-"));
		const home = path.join(root, "home");
		const skillsRoot = path.join(home, ".agents", "skills");
		const target = path.join(root, "shared", "linked");
		await mkdir(skillsRoot, { recursive: true });
		await mkdir(target, { recursive: true });
		await writeFile(path.join(target, "SKILL.md"), "---\nname: linked\n---\nLinked body");
		await symlink(target, path.join(skillsRoot, "linked"));
		await symlink(target, path.join(skillsRoot, "duplicate"));
		const fileLinkRoot = path.join(home, ".cursor", "skills");
		await mkdir(fileLinkRoot, { recursive: true });
		const fileTarget = path.join(root, "file-target", "SKILL.md");
		await mkdir(path.dirname(fileTarget), { recursive: true });
		await writeFile(fileTarget, "---\nname: file-linked\n---\nFile body");
		await symlink(fileTarget, path.join(fileLinkRoot, "SKILL.md"));
		await symlink(path.join(root, "missing"), path.join(skillsRoot, "dangling"));
		await symlink(skillsRoot, path.join(skillsRoot, "cycle"));
		try {
			const skills = await loadCustomSkills(root, home);
			expect(skills.map((skill) => skill.name)).toEqual(["file-linked", "linked"]);
			expect(skills.find((skill) => skill.name === "linked")?.sourcePath).toBe(
				path.join(target, "SKILL.md"),
			);
			expect(skills.find((skill) => skill.name === "file-linked")?.sourcePath).toBe(
				fileTarget,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps other skills when one directory cannot be read and logs a warning", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-skill-error-"));
		const home = path.join(root, "home");
		const bad = path.join(home, ".agents", "skills");
		const good = path.join(home, ".cursor", "skills-cursor", "good");
		await mkdir(bad, { recursive: true });
		await mkdir(good, { recursive: true });
		await writeFile(path.join(good, "SKILL.md"), "---\nname: good\n---\nGood body");
		const read = fs.readdir.bind(fs);
		const spy = vi.spyOn(fs, "readdir").mockImplementation((async (dir, options) => {
			if (dir === bad) throw Object.assign(new Error("denied"), { code: "EACCES" });
			return read(dir, options as { withFileTypes: true; encoding: "utf8" });
		}) as typeof fs.readdir);
		const warn = vi.fn();
		try {
			const skills = await loadCustomSkills(root, home, { warn });
			expect(skills.map((skill) => skill.name)).toEqual(["good"]);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining(bad), expect.any(Error));
		} finally {
			spy.mockRestore();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("finds ancestor skills through git root and prefers the nearest definition", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-skill-parent-"));
		const project = path.join(root, "project");
		const nested = path.join(project, "src", "nested");
		const parentSkill = path.join(project, ".agents", "skills", "parent");
		const localSkill = path.join(project, "src", ".agents", "skills", "local");
		const outsideSkill = path.join(root, ".agents", "skills", "outside");
		await mkdir(path.join(project, ".git"), { recursive: true });
		await mkdir(nested, { recursive: true });
		await mkdir(parentSkill, { recursive: true });
		await mkdir(localSkill, { recursive: true });
		await mkdir(outsideSkill, { recursive: true });
		await writeFile(path.join(parentSkill, "SKILL.md"), "---\nname: shared\n---\nParent body");
		await writeFile(path.join(localSkill, "SKILL.md"), "---\nname: shared\n---\nLocal body");
		await writeFile(
			path.join(outsideSkill, "SKILL.md"),
			"---\nname: outside\n---\nOutside body",
		);
		try {
			const skills = await loadCustomSkills(nested, path.join(root, "home"));
			expect(skills.find((skill) => skill.name === "shared")?.template).toBe("Local body");
			expect(skills.some((skill) => skill.name === "outside")).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps named skill directories while skipping nested examples, large directories and deep trees", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-skill-bounds-"));
		const skillsRoot = path.join(root, ".agents", "skills");
		const primary = path.join(skillsRoot, "primary");
		const example = path.join(primary, "examples", "nested");
		const ignored = path.join(skillsRoot, "node_modules", "ignored");
		const namedBuild = path.join(skillsRoot, "build");
		const deep = path.join(skillsRoot, ...Array.from({ length: 9 }, (_, i) => `level${i}`));
		for (const dir of [primary, example, ignored, namedBuild, deep])
			await mkdir(dir, { recursive: true });
		for (const [dir, name] of [
			[primary, "primary"],
			[example, "example"],
			[ignored, "ignored"],
			[namedBuild, "build"],
			[deep, "deep"],
		]) {
			await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\nBody`);
		}
		try {
			expect(
				(await loadCustomSkills(root, path.join(root, "home"))).map((skill) => skill.name),
			).toEqual(["build", "primary"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
