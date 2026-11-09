import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "./utils.js";

const MAX_SKILL_DEPTH = 8;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".worktrees", "dist", "build"]);

export type SkillOrigin = "workspace" | "user" | "cursor";

export interface CustomSkill {
	name: string;
	description: string;
	template: string;
	sourcePath: string;
	origin: SkillOrigin;
	linked: boolean;
	disableModelInvocation: boolean;
}

interface SkillFile {
	path: string;
	linked: boolean;
}

async function collectSkillFiles(
	dir: string,
	seen: Set<string>,
	warn: (message: string, error: unknown) => void,
	depth = 0,
	followLinks = true,
	viaLink = false,
): Promise<SkillFile[]> {
	if (depth > MAX_SKILL_DEPTH) return [];
	let realDir: string;
	try {
		realDir = await fs.realpath(dir);
	} catch (error) {
		if (!isMissing(error)) warn(`Unable to resolve skill directory ${dir}`, error);
		return [];
	}
	if (seen.has(realDir)) return [];
	seen.add(realDir);
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
	} catch (error: unknown) {
		if (!isMissing(error)) warn(`Unable to read skill directory ${dir}`, error);
		return [];
	}

	entries.sort((a, b) => a.name.localeCompare(b.name));

	const classified = await Promise.all(
		entries.map(async (entry) => {
			const fullPath = path.join(dir, entry.name);
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				if (!followLinks) return null;
				try {
					const target = await fs.stat(fullPath);
					isDirectory = target.isDirectory();
					isFile = target.isFile();
				} catch (error) {
					if (!isMissing(error)) warn(`Unable to follow skill link ${fullPath}`, error);
					return null;
				}
			}
			if (isDirectory && SKIPPED_DIRECTORIES.has(entry.name)) {
				try {
					isDirectory = (await fs.stat(path.join(fullPath, "SKILL.md"))).isFile();
				} catch (error) {
					if (!isMissing(error))
						warn(`Unable to inspect skill directory ${fullPath}`, error);
					isDirectory = false;
				}
			}
			return {
				fullPath,
				linked: viaLink || entry.isSymbolicLink(),
				isDirectory,
				isSkillFile: isFile && entry.name.toLowerCase() === "skill.md",
			};
		}),
	);
	const files: SkillFile[] = [];
	for (const item of classified) {
		if (!item?.isSkillFile) continue;
		try {
			const realFile = await fs.realpath(item.fullPath);
			if (!seen.has(realFile)) {
				seen.add(realFile);
				files.push({ path: realFile, linked: item.linked });
			}
		} catch (error) {
			if (!isMissing(error)) warn(`Unable to resolve skill file ${item.fullPath}`, error);
		}
	}
	// A directory with SKILL.md is one skill; supporting examples inside it are not separate skills.
	if (depth === 0 || !classified.some((item) => item?.isSkillFile)) {
		const children = classified.filter((item) => item?.isDirectory);
		for (const child of children) {
			files.push(
				...(await collectSkillFiles(
					child!.fullPath,
					seen,
					warn,
					depth + 1,
					followLinks,
					child!.linked,
				)),
			);
		}
	}

	return files;
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: string }).code === "ENOENT"
	);
}

async function workspaceDirectories(workspace: string): Promise<string[]> {
	const directories = [path.resolve(workspace)];
	let current = directories[0]!;
	while (path.dirname(current) !== current) {
		try {
			await fs.stat(path.join(current, ".git"));
			return directories;
		} catch (error) {
			if (!isMissing(error)) break;
		}
		current = path.dirname(current);
		directories.push(current);
	}
	return [directories[0]!];
}

function parseFrontmatter(markdown: string): {
	metadata: Record<string, string>;
	body: string;
} {
	const lines = markdown.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") {
		return { metadata: {}, body: markdown };
	}

	let end = -1;
	for (let i = 1; i < lines.length; i += 1) {
		if (lines[i]?.trim() === "---") {
			end = i;
			break;
		}
	}

	if (end === -1) {
		return { metadata: {}, body: markdown };
	}

	const metadata: Record<string, string> = {};
	const frontmatter = lines.slice(1, end);
	for (let i = 0; i < frontmatter.length; i += 1) {
		const line = frontmatter[i]!;
		const delimiter = line.indexOf(":");
		if (delimiter <= 0) {
			continue;
		}
		const key = line.slice(0, delimiter).trim().toLowerCase();
		let value = line.slice(delimiter + 1).trim();
		if (/^[>|][+-]?$/.test(value)) {
			const folded = value.startsWith(">");
			const block: string[] = [];
			while (i + 1 < frontmatter.length) {
				const next = frontmatter[i + 1]!;
				if (next.trim() && !/^\s/.test(next)) break;
				block.push(next);
				i += 1;
			}
			const indent = Math.min(
				...block.filter((part) => part.trim()).map((part) => part.search(/\S/)),
			);
			value = block
				.map((part) => part.slice(Number.isFinite(indent) ? indent : 0))
				.join("\n");
			if (folded) value = value.replace(/(?<=\S)\n(?=\S)/g, " ");
			value = value.trim();
		}
		if (key && value) {
			metadata[key] = value;
		}
	}

	return {
		metadata,
		body: lines.slice(end + 1).join("\n"),
	};
}

function firstHeading(markdown: string): string | undefined {
	const match = markdown.match(/^\s*#\s+(.+)$/m);
	if (!match?.[1]) {
		return undefined;
	}
	const heading = match[1].trim();
	return heading.length > 0 ? heading : undefined;
}

function cleanMetadataValue(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || trimmed === "''" || trimmed === '""') {
		return undefined;
	}
	return trimmed.replace(/^['"](.+)['"]$/, "$1").trim() || undefined;
}

async function readSkill(file: SkillFile, origin: SkillOrigin): Promise<CustomSkill | null> {
	const filePath = file.path;
	const raw = await fs.readFile(filePath, "utf8");
	const { metadata, body } = parseFrontmatter(raw);
	const template = body.trim();
	if (!template) {
		return null;
	}

	const heading = firstHeading(body);
	const dirName = path.basename(path.dirname(filePath)).trim();
	const name = cleanMetadataValue(metadata.name) || heading || dirName;
	if (!name) {
		return null;
	}

	const description =
		cleanMetadataValue(metadata.description) ||
		(heading && heading !== name ? heading : undefined) ||
		`Skill from ${dirName || path.basename(filePath)}`;

	return {
		name,
		description,
		template,
		sourcePath: filePath,
		origin,
		linked: file.linked,
		disableModelInvocation: metadata["disable-model-invocation"]?.toLowerCase() === "true",
	};
}

async function skillRoots(
	workspace: string,
	homeDirectory: string,
): Promise<Array<{ root: string; origin: SkillOrigin }>> {
	return [
		...(await workspaceDirectories(workspace)).flatMap((directory) => [
			{ root: path.join(directory, ".cursor", "skills"), origin: "workspace" as const },
			{ root: path.join(directory, ".agents", "skills"), origin: "workspace" as const },
		]),
		{ root: path.join(homeDirectory, ".agents", "skills"), origin: "user" },
		{ root: path.join(homeDirectory, ".cursor", "skills"), origin: "user" },
		{ root: path.join(homeDirectory, ".cursor", "skills-cursor"), origin: "cursor" },
	];
}

export async function loadCustomSkills(
	workspace: string,
	homeDirectory: string = os.homedir(),
	logger: Pick<Logger, "warn"> = console,
): Promise<CustomSkill[]> {
	const byName = new Map<string, CustomSkill>();
	const seen = new Set<string>();
	const warn = (message: string, error: unknown) =>
		logger.warn?.(`[cursor-acp] ${message}`, error);
	for (const { root, origin } of await skillRoots(workspace, homeDirectory)) {
		const files = await collectSkillFiles(root, seen, warn);
		for (const file of files) {
			let skill: CustomSkill | null;
			try {
				skill = await readSkill(file, origin);
			} catch (error) {
				if (!isMissing(error)) warn(`Unable to read skill file ${file.path}`, error);
				continue;
			}
			if (!skill) {
				continue;
			}
			const key = skill.name.toLowerCase();
			if (!byName.has(key)) {
				byName.set(key, skill);
			}
		}
	}

	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadSupplementalSkills(
	workspace: string,
	homeDirectory: string = os.homedir(),
	logger: Pick<Logger, "warn"> = console,
): Promise<CustomSkill[]> {
	const skills = await loadCustomSkills(workspace, homeDirectory, logger);
	const nativePaths = new Set<string>();
	const nativeNames = new Set<string>();
	const roots = await skillRoots(workspace, homeDirectory);
	for (const directory of await workspaceDirectories(workspace)) {
		for (const family of [".claude", ".codex"]) {
			roots.push({ root: path.join(directory, family, "skills"), origin: "workspace" });
		}
	}
	for (const family of [".claude", ".codex"]) {
		roots.push({ root: path.join(homeDirectory, family, "skills"), origin: "user" });
	}
	const warn = (message: string, error: unknown) =>
		logger.warn?.(`[cursor-acp] ${message}`, error);
	const seen = new Set<string>();
	for (const { root, origin } of roots) {
		for (const file of await collectSkillFiles(root, seen, warn, 0, false)) {
			try {
				const skill = await readSkill(file, origin);
				if (skill) {
					nativePaths.add(skill.sourcePath);
					nativeNames.add(skill.name.toLowerCase());
				}
			} catch (error) {
				if (!isMissing(error)) warn(`Unable to read skill file ${file.path}`, error);
			}
		}
	}
	return skills.filter(
		(skill) =>
			skill.linked &&
			!skill.disableModelInvocation &&
			!nativePaths.has(skill.sourcePath) &&
			!nativeNames.has(skill.name.toLowerCase()),
	);
}

export function resolveSkillPrompt(
	commandName: string,
	args: string,
	skills: CustomSkill[],
): string | null {
	const normalized = commandName.toLowerCase();
	const stripped = normalized.startsWith("skill:")
		? normalized.slice("skill:".length)
		: normalized.startsWith("skills:")
			? normalized.slice("skills:".length)
			: normalized.startsWith("skills/")
				? normalized.slice("skills/".length)
				: normalized;
	const match = skills.find((skill) => skill.name.toLowerCase() === stripped);
	if (!match) return null;
	const prompt = `Skill file: ${match.sourcePath}\nSkill directory: ${path.dirname(match.sourcePath)}\n\n${match.template}`;
	return args.trim() ? `${prompt}\n\n${args.trim()}` : prompt;
}
