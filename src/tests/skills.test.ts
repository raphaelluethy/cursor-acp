import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadCustomSkills } from "../skills.js";

describe("skills", () => {
  it("loads skills from workspace, user, and cursor roots", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-skill-"));
    const workspace = path.join(tempRoot, "workspace");
    const home = path.join(tempRoot, "home");

    const workspaceSkill = path.join(
      workspace,
      ".cursor",
      "skills",
      "workspace-skill",
    );
    const userSkill = path.join(home, ".cursor", "skills", "user-skill");
    const cursorSkill = path.join(
      home,
      ".cursor",
      "skills-cursor",
      "cursor-skill",
    );

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
      [
        "---",
        "name: user-skill",
        "description: User skill",
        "---",
        "User skill body",
      ].join("\n"),
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
      const workspaceSkillLoaded = skills.find(
        (skill) => skill.name === "workspace-skill",
      );

      expect(cursor?.origin).toBe("cursor");
      expect(user?.origin).toBe("user");
      expect(workspaceSkillLoaded?.origin).toBe("workspace");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
