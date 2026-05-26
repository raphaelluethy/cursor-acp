import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CursorCliAttribution {
	attributeCommitsToAgent: boolean;
	attributePRsToAgent: boolean;
}

export interface LoadedCursorCliConfig {
	userConfigPath: string;
	projectConfigPaths: string[];
	attribution: CursorCliAttribution;
}

/** Default attribution when no user/project config is loaded (matches SDK defaults). */
export const DEFAULT_CURSOR_CLI_ATTRIBUTION: CursorCliAttribution = {
	attributeCommitsToAgent: true,
	attributePRsToAgent: true,
};

/** Resolve the Cursor config directory (same rules as the SDK). */
export function getCursorConfigDir(): string {
	const fromEnv = process.env.CURSOR_CONFIG_DIR?.trim();
	if (fromEnv) {
		return fromEnv;
	}
	const xdg = process.env.XDG_CONFIG_HOME?.trim();
	if (xdg) {
		return join(xdg, "cursor");
	}
	return join(homedir(), ".cursor");
}

function readJsonObject(path: string): Record<string, unknown> | null {
	if (!existsSync(path)) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function readAttributionOverrides(
	config: Record<string, unknown> | null,
): Partial<CursorCliAttribution> {
	const attribution = config?.attribution;
	if (!attribution || typeof attribution !== "object" || Array.isArray(attribution)) {
		return {};
	}
	const values = attribution as Record<string, unknown>;
	return {
		...(typeof values.attributeCommitsToAgent === "boolean"
			? { attributeCommitsToAgent: values.attributeCommitsToAgent }
			: {}),
		...(typeof values.attributePRsToAgent === "boolean"
			? { attributePRsToAgent: values.attributePRsToAgent }
			: {}),
	};
}

function findGitRoot(cwd: string): string | undefined {
	try {
		return execSync("git rev-parse --show-toplevel", {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return undefined;
	}
}

/** Collect `.cursor/cli.json` paths from git root through cwd (deeper wins). */
export function collectProjectCliConfigPaths(cwd: string): string[] {
	const gitRoot = findGitRoot(cwd) ?? cwd;
	const paths: string[] = [];
	let current = gitRoot;

	while (true) {
		paths.push(join(current, ".cursor", "cli.json"));
		if (current === cwd) {
			break;
		}
		const parent = join(current, "..");
		if (parent === current) {
			break;
		}
		current = parent;
	}

	return [...new Set(paths.filter((path) => existsSync(path)))];
}

/** Read user + project CLI config layers the same way `settingSources` expects. */
export function loadCursorCliConfig(cwd: string = process.cwd()): LoadedCursorCliConfig {
	const userConfigPath = join(getCursorConfigDir(), "cli-config.json");
	const userConfig = readJsonObject(userConfigPath);
	const projectConfigPaths = collectProjectCliConfigPaths(cwd);

	const attribution: CursorCliAttribution = { ...DEFAULT_CURSOR_CLI_ATTRIBUTION };
	Object.assign(attribution, readAttributionOverrides(userConfig));
	for (const path of projectConfigPaths) {
		Object.assign(attribution, readAttributionOverrides(readJsonObject(path)));
	}

	return { userConfigPath, projectConfigPaths, attribution };
}

export function commitAttributionEnabled(config: LoadedCursorCliConfig): boolean {
	return config.attribution.attributeCommitsToAgent;
}

/** Detect Cursor commit attribution flags in a shell command string. */
export function shellCommandHasCommitAttribution(command: string): boolean {
	const normalized = command.toLowerCase();
	return (
		normalized.includes("co-authored-by") ||
		command.includes("cursoragent@cursor.com") ||
		/\bgit\s+commit\b[^;\n|&]*--trailer\b/i.test(command)
	);
}
