#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sqlite3Dir = join(root, "node_modules", "sqlite3");

if (!existsSync(sqlite3Dir)) {
	process.exit(0);
}

const proc = Bun.spawnSync(["bun", "run", "install"], {
	cwd: sqlite3Dir,
	stdout: "inherit",
	stderr: "inherit",
});

if (proc.exitCode !== 0) {
	console.error(
		"cursor-acp: failed to build sqlite3 for @cursor/sdk (local agent persistence).",
		"Install Xcode Command Line Tools on macOS, then rerun: bun run postinstall",
	);
	process.exit(proc.exitCode ?? 1);
}
